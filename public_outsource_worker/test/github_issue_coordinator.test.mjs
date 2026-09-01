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
  resolveRuntimeEnvelope,
} from "../src/index.mjs";

const OWNER = "repository-owner";
const BOT = "outsource-bot";
const RECORD_ID = "267a034fb6674d629db7aaacddff36b8";

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
  const rawBytes = Buffer.from(rawTender);
  return createPublicRuntime({
    fetchImpl: async () => {
      onFetch();
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          rawBytes.buffer.slice(
            rawBytes.byteOffset,
            rawBytes.byteOffset + rawBytes.byteLength,
          ),
      };
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

test("terminal encoding contains official text without allowing HTML-marker injection", async () => {
  const { dispatcher } = runtime();
  const result = await dispatcher.dispatch(descriptor().envelope);
  result.result.normalized.procuring_entity = {
    legal_name: "Injected --> @everyone",
    identifier: null,
    kind: null,
  };
  const terminal = createTerminal(result);
  const body = formatTerminalComment(terminal);
  assert.equal((body.match(/-->/g) ?? []).length, 1);
  assert.equal(body.includes("@everyone"), false);
  assert.deepEqual(
    parseBotTerminalComment({ user: { login: BOT }, body }, BOT),
    terminal,
  );
});

test("terminal comment size is bounded before GitHub posting", async () => {
  const { dispatcher } = runtime();
  const result = await dispatcher.dispatch(descriptor().envelope);
  result.result.padding = "x".repeat(50_000);
  const terminal = createTerminal(result);
  assert.throws(() => formatTerminalComment(terminal), {
    code: "TERMINAL_TOO_LARGE",
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
    existingIssues: [
      { number: 42, user: { login: BOT }, ...first.next_issue },
    ],
  });
  assert.equal(replay.action, "NOOP_ALREADY_TERMINAL");
  assert.equal(replay.next_issue, null);
  assert.equal(fetches, 1);

  assert.equal(
    planNextIssue({
      descriptor: descriptor(),
      issueNumber: 41,
      terminal: first.terminal,
      existingIssues: [
        { number: 42, user: { login: BOT }, ...first.next_issue },
      ],
      generatedByLogin: BOT,
    }),
    null,
  );
});

test("generated BUBO child cannot independently trigger the owner-only workflow", async () => {
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
  assert.throws(() => parseOwnerTaskIssue(childEvent), {
    code: "ISSUE_AUTHOR_REJECTED",
  });

  const botCuckoo = issueEvent();
  botCuckoo.issue.user.login = BOT;
  assert.throws(
    () => parseOwnerTaskIssue(botCuckoo),
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
        existingIssues: [
          {
            number: 42,
            title: first.next_issue.title,
            body: "{}",
            user: { login: BOT },
          },
        ],
        generatedByLogin: BOT,
      }),
    { code: "NEXT_ISSUE_CONFLICT" },
  );
});

test("parent terminal case must match the BUBO child case", async () => {
  const { dispatcher } = runtime();
  const parent = await coordinateIssueTask({
    event: issueEvent(),
    dispatcher,
    botLogin: BOT,
  });
  const child = JSON.parse(parent.next_issue.body);
  child.envelope.case_id = "OTHER-CASE";
  assert.throws(
    () =>
      resolveRuntimeEnvelope(
        child,
        [{ user: { login: BOT }, body: parent.comment_body }],
        BOT,
      ),
    { code: "DEPENDENCY_CASE_MISMATCH" },
  );
});

test("task_id is globally bound to one issue number", async (t) => {
  const { dispatcher } = runtime();
  const event = issueEvent();
  const current = {
    number: 41,
    title: event.issue.title,
    body: event.issue.body,
    user: { login: OWNER },
  };
  const duplicate = { ...current, number: 99 };
  await expectCode(
    coordinateIssueTask({
      event,
      dispatcher,
      botLogin: BOT,
      existingIssues: [current, duplicate],
    }),
    "DUPLICATE_TASK_ISSUE",
  );

  await t.test("same title already bound to another issue", async () => {
    await expectCode(
      coordinateIssueTask({
        event,
        dispatcher,
        botLogin: BOT,
        existingIssues: [duplicate],
      }),
      "DUPLICATE_TASK_ISSUE",
    );
  });
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
