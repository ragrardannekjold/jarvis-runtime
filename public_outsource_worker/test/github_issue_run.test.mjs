import assert from "node:assert/strict";
import test from "node:test";

import {
  ISSUE_SCHEMA,
  ISSUE_TITLE_PREFIX,
  WorkerError,
  createPublicRuntime,
  runBoundedIssueChain,
} from "../src/index.mjs";

const OWNER = "repository-owner";
const BOT = "github-actions[bot]";
const RECORD_ID = "267a034fb6674d629db7aaacddff36b8";
const RAW = JSON.stringify({
  data: {
    id: RECORD_ID,
    tenderID: "UA-2026-02-21-000440-a",
    status: "active",
    value: { amount: 100, currency: "UAH", valueAddedTaxIncluded: true },
    contracts: [],
  },
});

function rootDescriptor() {
  return {
    schema: ISSUE_SCHEMA,
    envelope: {
      task_id: "donbas.chain.001",
      case_id: "DON-V2-01",
      worker: "cuckoo",
      capability: "prozorro_snapshot_v1",
      sensitivity: "PUBLIC",
      payload: { record_id: RECORD_ID },
    },
    next: { worker: "bubo", capability: "evidence_packet_v1" },
    depends_on: null,
  };
}

function rootEvent() {
  const value = rootDescriptor();
  return {
    action: "opened",
    repository: { owner: { login: OWNER }, private: false },
    issue: {
      number: 41,
      title: `${ISSUE_TITLE_PREFIX}${value.envelope.task_id}`,
      body: JSON.stringify(value),
      user: { login: OWNER },
    },
  };
}

class FakeGithub {
  constructor(event) {
    this.issueIndex = [
      {
        number: event.issue.number,
        title: event.issue.title,
        body: event.issue.body,
        user: { login: OWNER },
      },
    ];
    this.commentIndex = new Map([[event.issue.number, []]]);
    this.created = [];
    this.posted = [];
    this.locked = new Set();
    this.nextNumber = 42;
  }

  async taskIssues(taskId, trustedAuthorLogin) {
    return structuredClone(
      this.issueIndex.filter(
        (issue) =>
          issue.title === `${ISSUE_TITLE_PREFIX}${taskId}` &&
          issue.user?.login === trustedAuthorLogin,
      ),
    );
  }

  async comments(number) {
    return structuredClone(this.commentIndex.get(number) ?? []);
  }

  async comment(number, body) {
    const comment = { user: { login: BOT }, body };
    this.commentIndex.set(number, [...(this.commentIndex.get(number) ?? []), comment]);
    this.posted.push({ number, body });
    return structuredClone(comment);
  }

  async createIssue(issue) {
    const created = {
      number: this.nextNumber++,
      ...structuredClone(issue),
      user: { login: BOT },
    };
    this.issueIndex.push(created);
    this.commentIndex.set(created.number, []);
    this.created.push(created);
    return structuredClone(created);
  }

  async lockIssue(number) {
    this.locked.add(number);
    return null;
  }
}

function runtime(onFetch = () => {}) {
  const rawBytes = Buffer.from(RAW);
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

test("one owner event executes the bounded Cuckoo to BUBO chain in the same run", async () => {
  const event = rootEvent();
  const github = new FakeGithub(event);
  let fetches = 0;
  const { dispatcher } = runtime(() => {
    fetches += 1;
  });
  const summary = await runBoundedIssueChain({
    event,
    dispatcher,
    botLogin: BOT,
    github,
  });

  assert.equal(summary.adapter_executions, 2);
  assert.equal(summary.parent.action, "COMMENT_TERMINAL");
  assert.equal(summary.child.issue_action, "CREATED");
  assert.equal(summary.child.action, "COMMENT_TERMINAL");
  assert.equal(github.created.length, 1);
  assert.equal(github.posted.length, 2);
  assert.deepEqual([...github.locked].sort((a, b) => a - b), [41, 42]);
  assert.equal(fetches, 1);

  const replay = await runBoundedIssueChain({
    event,
    dispatcher: runtime().dispatcher,
    botLogin: BOT,
    github,
  });
  assert.equal(replay.adapter_executions, 0);
  assert.equal(replay.parent.action, "NOOP_ALREADY_TERMINAL");
  assert.equal(replay.child.issue_action, "RESUMED");
  assert.equal(replay.child.action, "NOOP_ALREADY_TERMINAL");
  assert.equal(github.created.length, 1);
  assert.equal(github.posted.length, 2);
});

test("root conversation lock fails before any official source read", async () => {
  const event = rootEvent();
  class LockFailureGithub extends FakeGithub {
    async lockIssue() {
      throw new Error("lock unavailable");
    }
  }
  let fetches = 0;
  await assert.rejects(
    runBoundedIssueChain({
      event,
      dispatcher: runtime(() => {
        fetches += 1;
      }).dispatcher,
      botLogin: BOT,
      github: new LockFailureGithub(event),
    }),
    /lock unavailable/,
  );
  assert.equal(fetches, 0);
});

test("rerun resumes an existing deterministic child that has no terminal", async () => {
  const event = rootEvent();
  const github = new FakeGithub(event);
  const real = runtime();
  const failingDispatcher = {
    async dispatch(envelope) {
      if (envelope.worker === "bubo") {
        throw new WorkerError("TEST_INTERRUPTION", "stop after child creation");
      }
      return real.dispatcher.dispatch(envelope);
    },
  };
  await expectCode(
    runBoundedIssueChain({
      event,
      dispatcher: failingDispatcher,
      botLogin: BOT,
      github,
    }),
    "TEST_INTERRUPTION",
  );
  assert.equal(github.created.length, 1);
  assert.equal(github.posted.length, 1);

  const resumed = await runBoundedIssueChain({
    event,
    dispatcher: runtime().dispatcher,
    botLogin: BOT,
    github,
  });
  assert.equal(resumed.adapter_executions, 1);
  assert.equal(resumed.child.issue_action, "RESUMED");
  assert.equal(resumed.child.action, "COMMENT_TERMINAL");
  assert.equal(github.created.length, 1);
  assert.equal(github.posted.length, 2);
});

test("global duplicate root issue blocks execution before source fetch", async () => {
  const event = rootEvent();
  const github = new FakeGithub(event);
  github.issueIndex.push({ ...github.issueIndex[0], number: 99 });
  let fetches = 0;
  await expectCode(
    runBoundedIssueChain({
      event,
      dispatcher: runtime(() => {
        fetches += 1;
      }).dispatcher,
      botLogin: BOT,
      github,
    }),
    "DUPLICATE_TASK_ISSUE",
  );
  assert.equal(fetches, 0);
});

test("an untrusted same-title root issue cannot poison owner dispatch", async () => {
  const event = rootEvent();
  const github = new FakeGithub(event);
  github.issueIndex.push({
    ...github.issueIndex[0],
    number: 99,
    user: { login: "untrusted-user" },
  });
  const summary = await runBoundedIssueChain({
    event,
    dispatcher: runtime().dispatcher,
    botLogin: BOT,
    github,
  });
  assert.equal(summary.adapter_executions, 2);
  assert.equal(github.created.length, 1);
});

test("an attacker-precreated child is ignored in favor of a bot-authored child", async () => {
  const event = rootEvent();
  const github = new FakeGithub(event);
  github.issueIndex.push({
    number: 99,
    title: `${ISSUE_TITLE_PREFIX}${rootDescriptor().envelope.task_id}.bubo`,
    body: "{}",
    user: { login: "untrusted-user" },
  });
  const summary = await runBoundedIssueChain({
    event,
    dispatcher: runtime().dispatcher,
    botLogin: BOT,
    github,
  });
  assert.equal(summary.child.issue_action, "CREATED");
  assert.equal(github.created[0].user.login, BOT);
});

test("post-create duplicate child race fails before BUBO execution", async () => {
  const event = rootEvent();
  class RacingGithub extends FakeGithub {
    async createIssue(issue) {
      const created = await super.createIssue(issue);
      this.issueIndex.push({
        ...structuredClone(created),
        number: 99,
      });
      return created;
    }
  }
  const github = new RacingGithub(event);
  let buboRuns = 0;
  const real = runtime();
  await expectCode(
    runBoundedIssueChain({
      event,
      dispatcher: {
        async dispatch(envelope) {
          if (envelope.worker === "bubo") buboRuns += 1;
          return real.dispatcher.dispatch(envelope);
        },
      },
      botLogin: BOT,
      github,
    }),
    "DUPLICATE_TASK_ISSUE",
  );
  assert.equal(buboRuns, 0);
  assert.equal(github.posted.length, 1);
});

test("returned terminal authorship is verified before BUBO trusts it", async () => {
  const event = rootEvent();
  class ForgedCommentGithub extends FakeGithub {
    async comment(number, body) {
      const posted = await super.comment(number, body);
      return { ...posted, user: { login: "untrusted-user" } };
    }
  }
  const github = new ForgedCommentGithub(event);
  await expectCode(
    runBoundedIssueChain({
      event,
      dispatcher: runtime().dispatcher,
      botLogin: BOT,
      github,
    }),
    "UNTRUSTED_TERMINAL_AUTHOR",
  );
  assert.equal(github.created.length, 0);
});

test("global duplicate child task blocks BUBO resume", async () => {
  const event = rootEvent();
  const github = new FakeGithub(event);
  const real = runtime();
  await expectCode(
    runBoundedIssueChain({
      event,
      dispatcher: {
        async dispatch(envelope) {
          if (envelope.worker === "bubo") {
            throw new WorkerError("TEST_INTERRUPTION", "leave child pending");
          }
          return real.dispatcher.dispatch(envelope);
        },
      },
      botLogin: BOT,
      github,
    }),
    "TEST_INTERRUPTION",
  );
  github.issueIndex.push({ ...github.created[0], number: 99 });
  await expectCode(
    runBoundedIssueChain({
      event,
      dispatcher: runtime().dispatcher,
      botLogin: BOT,
      github,
    }),
    "DUPLICATE_TASK_ISSUE",
  );
});
