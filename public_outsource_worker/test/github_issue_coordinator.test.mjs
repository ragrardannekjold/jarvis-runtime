import assert from "node:assert/strict";
import test from "node:test";

import {
  ISSUE_SCHEMA,
  ISSUE_TITLE_PREFIX,
  WorkerError,
  coordinateIssueTask,
  createPublicRuntime,
  createTerminal,
  formatTerminalComment,
  parseBotTerminalComment,
  parseOwnerTaskIssue,
  planNextIssue,
} from "../src/index.mjs";

const OWNER = "repository-owner";
const BOT = "outsource-bot";
const RECORD_ID = "0123456789abcdef0123456789abcdef";

const rawTender = JSON.stringify({
  data: {
    id: RECORD_ID,
    tenderID: "UA-2026-02-21-000440-a",
    status: "active",
    value: { amount: 100, currency: "UAH", valueAddedTaxIncluded: true },
    contracts: [],
  },
});

function descriptor(overrides = {}) {
  return {
    schema: ISSUE_SCHEMA,
    envelope: {
      task_id: "donbas.procurement.001",
      case_id: "DON-V2-01",
      worker: "cuckoo",
      capability: "prozorro_snapshot_v1",
      sensitivity: "PUBLIC",
      payload: { record_id: RECORD_ID },
    },
    next: { worker: "bubo", capability: "evidence_packet_v1" },
    depends_on: null,
    ...overrides,
  };
}

function issueEvent(value = descriptor(), overrides = {}) {
  return {
    action: "opened",
    repository: { owner: { login: OWNER }, private: false },
    issue: {
      number: 41,
      title: `${ISSUE_TITLE_PREFIX}${value.envelope.task_id}`,
      body: JSON.stringify(value),
      user: { login: OWNER },
    },
    ...overrides,
  };
}

function runtime(onFetch = () => {}) {
  return createPublicRuntime({
    fetchImpl: async () => {
      onFetch();
      return { ok: true, status: 200, text: async () => rawTender };
    },
    now: () => "2026-09-01T12:00:00.000Z",
  });
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof WorkerError);
    assert.equal(error.code, code);
    return true;
  });
}

test("only an owner-created exact OUTSOURCE-TASK issue is accepted", async (t) => {
  const parsed = parseOwnerTaskIssue(issueEvent());
  assert.equal(parsed.envelope.task_id, "donbas.procurement.001");

  await t.test("non-owner", async () => {
    const event = issueEvent();
    event.issue.user.login = "someone-else";
    assert.throws(() => parseOwnerTaskIssue(event), { code: "ISSUE_AUTHOR_REJECTED" });
  });
  await t.test("non-opened event", async () => {
    const event = issueEvent();
    event.action = "edited";
    assert.throws(() => parseOwnerTaskIssue(event), { code: "ISSUE_ACTION_REJECTED" });
  });
  await t.test("private repository", async () => {
    const event = issueEvent();
    event.repository.private = true;
    assert.throws(() => parseOwnerTaskIssue(event), { code: "REPOSITORY_NOT_PUBLIC" });
  });
  await t.test("descriptor extras", async () => {
    const event = issueEvent({ ...descriptor(), arbitrary_url: "https://example.invalid" });
    assert.throws(() => parseOwnerTaskIssue(event), { code: "INVALID_ISSUE_DESCRIPTOR" });
  });
});

test("terminal marker is immutable and validates its configured bot author", async () => {
  const { dispatcher } = runtime();
  const result = await dispatcher.dispatch(descriptor().envelope);
  const terminal = createTerminal(result);
  const comment = { user: { login: BOT }, body: formatTerminalComment(terminal) };
  assert.deepEqual(parseBotTerminalComment(comment, BOT), terminal);

  const tampered = structuredClone(terminal);
  tampered.result.result.normalized.status = "cancelled";
  assert.throws(() => formatTerminalComment(tampered), {
    code: "TERMINAL_HASH_MISMATCH",
  });
  assert.throws(() => parseBotTerminalComment(comment, "different-bot"), {
    code: "UNTRUSTED_TERMINAL_AUTHOR",
  });
});

test("Cuckoo issue emits one terminal and one deterministic BUBO plan", async () => {
  let fetches = 0;
  const { dispatcher } = runtime(() => {
    fetches += 1;
  });
  const event = issueEvent();
  const first = await coordinateIssueTask({
    event,
    dispatcher,
    botLogin: BOT,
  });
  assert.equal(first.action, "COMMENT_TERMINAL");
  assert.equal(first.next_issue.title, "[OUTSOURCE-TASK] donbas.procurement.001.bubo");
  assert.equal(fetches, 1);

  const existingComment = { user: { login: BOT }, body: first.comment_body };
  const replay = await coordinateIssueTask({
    event,
    dispatcher,
    botLogin: BOT,
    existingComments: [existingComment],
    existingIssues: [first.next_issue],
  });
  assert.equal(replay.action, "NOOP_ALREADY_TERMINAL");
  assert.equal(replay.next_issue, null);
  assert.equal(fetches, 1);

  assert.equal(
    planNextIssue({
      descriptor: descriptor(),
      issueNumber: 41,
      terminal: first.terminal,
      existingIssues: [first.next_issue],
    }),
    null,
  );
});

test("configured bot may create only the provenance-pinned BUBO child", async () => {
  const { dispatcher } = runtime();
  const parent = await coordinateIssueTask({
    event: issueEvent(),
    dispatcher,
    botLogin: BOT,
  });
  const child = JSON.parse(parent.next_issue.body);
  const childEvent = issueEvent(child, {
    issue: {
      number: 42,
      title: parent.next_issue.title,
      body: parent.next_issue.body,
      user: { login: BOT },
    },
  });
  assert.equal(
    parseOwnerTaskIssue(childEvent, { generatedBotLogin: BOT }).envelope.worker,
    "bubo",
  );

  const botCuckoo = issueEvent();
  botCuckoo.issue.user.login = BOT;
  assert.throws(
    () => parseOwnerTaskIssue(botCuckoo, { generatedBotLogin: BOT }),
    { code: "ISSUE_AUTHOR_REJECTED" },
  );
});

test("same deterministic BUBO title with altered body is a hard conflict", async () => {
  const { dispatcher } = runtime();
  const first = await coordinateIssueTask({
    event: issueEvent(),
    dispatcher,
    botLogin: BOT,
  });
  assert.throws(
    () =>
      planNextIssue({
        descriptor: descriptor(),
        issueNumber: 41,
        terminal: first.terminal,
        existingIssues: [{ title: first.next_issue.title, body: "{}" }],
      }),
    { code: "NEXT_ISSUE_CONFLICT" },
  );
});

test("BUBO resolves only a validated prior bot terminal and emits evidence packet", async () => {
  const { dispatcher } = runtime();
  const cuckooRun = await coordinateIssueTask({
    event: issueEvent(),
    dispatcher,
    botLogin: BOT,
  });
  const childDescriptor = JSON.parse(cuckooRun.next_issue.body);
  const childEvent = issueEvent(childDescriptor, {
    issue: {
      number: 42,
      title: cuckooRun.next_issue.title,
      body: cuckooRun.next_issue.body,
      user: { login: OWNER },
    },
  });
  const priorComment = { user: { login: BOT }, body: cuckooRun.comment_body };
  const buboRun = await coordinateIssueTask({
    event: childEvent,
    dispatcher,
    botLogin: BOT,
    priorComments: [priorComment],
  });
  assert.equal(buboRun.terminal.worker, "bubo");
  assert.equal(buboRun.terminal.result.result.schema, "public.evidence_packet.v1");
  assert.equal(buboRun.terminal.result.result.canonical_admission, "PENDING_VERIFIER");
  assert.equal(buboRun.next_issue, null);
});

test("BUBO rejects missing or hash-mismatched prior results", async (t) => {
  const { dispatcher } = runtime();
  const parent = await coordinateIssueTask({
    event: issueEvent(),
    dispatcher,
    botLogin: BOT,
  });
  const child = JSON.parse(parent.next_issue.body);
  const event = issueEvent(child, {
    issue: {
      number: 42,
      title: parent.next_issue.title,
      body: parent.next_issue.body,
      user: { login: OWNER },
    },
  });

  await t.test("missing", async () => {
    await expectCode(
      coordinateIssueTask({ event, dispatcher, botLogin: BOT }),
      "DEPENDENCY_NOT_READY",
    );
  });
  await t.test("wrong pinned hash", async () => {
    const changed = structuredClone(child);
    changed.depends_on.result_sha256 = "f".repeat(64);
    const changedEvent = issueEvent(changed, {
      issue: {
        number: 43,
        title: parent.next_issue.title,
        body: JSON.stringify(changed),
        user: { login: OWNER },
      },
    });
    await expectCode(
      coordinateIssueTask({
        event: changedEvent,
        dispatcher,
        botLogin: BOT,
        priorComments: [{ user: { login: BOT }, body: parent.comment_body }],
      }),
      "DEPENDENCY_HASH_MISMATCH",
    );
  });
});
