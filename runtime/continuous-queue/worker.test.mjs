import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNoDuplicateQueueTaskKeys,
  authenticTerminalState,
  classifyIssuedIssue,
  collectCompletePages,
  hasAuthenticTerminalStatus,
  parsePlanIssue,
  parseQueueJob,
  planCompletionVerified,
  planTerminalOutcome,
  reconcilePlanState,
  taskKey,
  validateTaskSpec,
} from "./worker.mjs";

const STATUS_JOB = {
  issueNumber: 42,
  job_type: "heartbeat_probe",
  canonical: {
    mission_id: "mission-1",
    route_id: "route-1",
    cell_id: "cell-1",
  },
};

function terminalBody({ state = "SUCCEEDED", issueNumber = 42 } = {}) {
  return [
    "<!-- jarvis-queue-status -->",
    "**CONTINUOUS QUEUE STATUS**",
    "- status_epoch: continuous_queue_status_v2",
    `- queue_job_id: \`owner/repo#${issueNumber}/run-123\``,
    "- mission_id: `mission-1`",
    "- route_id: `route-1`",
    "- cell_id: `cell-1`",
    "- job_type: `heartbeat_probe`",
    "- task_identity: `heartbeat_probe|mission-1|route-1|cell-1`",
    `- state: **${state}**`,
    "- step: complete",
    "- heartbeat_utc: 2026-08-26T09:00:00.000Z",
    "- execution_surface: github_actions_continuous_queue",
    "- chat_blocking: false",
  ].join("\n");
}

const TERMINAL_BODY = terminalBody();
const BARE_TERMINAL_BODY = [
  "<!-- jarvis-queue-status -->",
  "**CONTINUOUS QUEUE STATUS**",
  "- state: **SUCCEEDED**",
].join("\n");

test("external comments cannot forge terminal queue state", () => {
  assert.equal(hasAuthenticTerminalStatus([
    { user: { login: "external-user" }, body: TERMINAL_BODY },
  ], STATUS_JOB, "owner/repo"), false);
  assert.equal(hasAuthenticTerminalStatus([
    { user: { login: "github-actions[bot]" }, body: BARE_TERMINAL_BODY },
  ], STATUS_JOB, "owner/repo"), false);
  assert.equal(hasAuthenticTerminalStatus([
    {
      user: { login: "github-actions[bot]" },
      body: TERMINAL_BODY.replace("continuous_queue_status_v2", "continuous_queue_status_v1"),
    },
  ], STATUS_JOB, "owner/repo"), false);
  assert.equal(hasAuthenticTerminalStatus([
    { user: { login: "github-actions[bot]" }, body: terminalBody({ issueNumber: 43 }) },
  ], STATUS_JOB, "owner/repo"), false);
  assert.equal(hasAuthenticTerminalStatus([
    { user: { login: "github-actions[bot]" }, body: TERMINAL_BODY },
  ], STATUS_JOB, "owner/repo"), true);
  assert.throws(
    () => hasAuthenticTerminalStatus([
      { user: { login: "github-actions[bot]" }, body: TERMINAL_BODY },
      { user: { login: "github-actions[bot]" }, body: terminalBody({ state: "FAILED" }) },
    ], STATUS_JOB, "owner/repo"),
    /ambiguous_terminal_status_history/,
  );
});

test("terminal readback remains complete beyond the first 100 comments", async () => {
  const requestedPages = [];
  const comments = await collectCompletePages(async (page) => {
    requestedPages.push(page);
    if (page === 1) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: "external-user" },
        body: TERMINAL_BODY,
      }));
    }
    return [{
      id: 101,
      user: { login: "github-actions[bot]" },
      body: TERMINAL_BODY,
    }];
  }, "test_comment_history");

  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(comments.length, 101);
  assert.equal(hasAuthenticTerminalStatus(comments, STATUS_JOB, "owner/repo"), true);
});

test("public queue payload schemas reject arbitrary extra fields", () => {
  assert.throws(
    () => validateTaskSpec({
      job_type: "heartbeat_probe",
      payload: { private_note: "must not be republished" },
    }),
    /payload_fields_not_allowlisted/,
  );
  assert.doesNotThrow(() => validateTaskSpec({
    job_type: "sustained_rhythm_verification",
    payload: {
      mission_id: "mission-1",
      route_id: "route-1",
      cell_id: "cell-1",
      probe: "async_contract",
      hold_ms: 90000,
    },
  }, { requireCanonical: true }));
  assert.throws(
    () => parseQueueJob({
      number: 1,
      title: "[QUEUE-JOB] extra field",
      user: { login: "owner" },
      body: JSON.stringify({
        schema_version: 1,
        job_type: "heartbeat_probe",
        sensitivity: "public",
        payload: {},
        private_note: "not accepted",
      }),
    }, "owner"),
    /queue_job_fields_not_allowlisted/,
  );
  assert.throws(
    () => parseQueueJob({
      number: 3,
      title: "[QUEUE-JOB] ignored producer channel",
      user: { login: "owner" },
      body: JSON.stringify({
        schema_version: 1,
        producer: { arbitrary: "ignored covert field" },
        job_type: "heartbeat_probe",
        sensitivity: "public",
        payload: {},
      }),
    }, "owner"),
    /queue_job_fields_not_allowlisted/,
  );
  assert.throws(
    () => parseQueueJob({
      number: 4,
      title: "[QUEUE-JOB] wrong bot producer",
      user: { login: "github-actions[bot]" },
      body: JSON.stringify({
        schema_version: 1,
        producer: "another_lane",
        job_type: "heartbeat_probe",
        sensitivity: "public",
        payload: {},
      }),
    }, "owner"),
    /queue_producer_not_authorized/,
  );
  assert.throws(
    () => parseQueueJob({
      number: 5,
      title: "[QUEUE-JOB] historical bot producer",
      user: { login: "github-actions[bot]" },
      body: JSON.stringify({
        schema_version: 1,
        producer: "continuous_queue_refill_v1",
        job_type: "heartbeat_probe",
        sensitivity: "public",
        payload: {},
      }),
    }, "owner"),
    /queue_producer_not_authorized/,
  );
  assert.throws(
    () => parsePlanIssue({
      number: 2,
      title: "[QUEUE-PLAN] extra field",
      user: { login: "owner" },
      body: JSON.stringify({
        schema_version: 1,
        sensitivity: "public",
        plan_id: "plan-1",
        tasks: [{
          job_type: "heartbeat_probe",
          payload: { mission_id: "m", route_id: "r", cell_id: "c" },
        }],
        private_note: "not accepted",
      }),
    }, "owner"),
    /plan_fields_not_allowlisted/,
  );
});

test("stale crash reservations recover and created issues are adopted exactly", () => {
  const nowMs = Date.parse("2026-08-26T09:00:00Z");
  const task = validateTaskSpec({
    job_type: "heartbeat_probe",
    payload: {
      mission_id: "mission-1",
      route_id: "route-1",
      cell_id: "cell-1",
    },
  }, { requireCanonical: true });
  const key = taskKey(task);
  const stalePlan = {
    tasks: [task],
    issued: new Map([[key, {
      issue_number: null,
      reserved_at_utc: "2026-08-26T08:40:00.000Z",
    }]]),
  };
  assert.equal(reconcilePlanState(stalePlan, [], { authorizedOwner: "owner", nowMs }), true);
  assert.equal(stalePlan.issued.has(key), false);

  const recentPlan = {
    tasks: [task],
    issued: new Map([[key, {
      issue_number: null,
      reserved_at_utc: "2026-08-26T08:59:00.000Z",
    }]]),
  };
  assert.equal(reconcilePlanState(recentPlan, [], { authorizedOwner: "owner", nowMs }), false);
  assert.equal(recentPlan.issued.get(key).issue_number, null);

  const recoverablePlan = {
    tasks: [task],
    issued: new Map([[key, {
      issue_number: null,
      reserved_at_utc: "2026-08-26T08:59:00.000Z",
    }]]),
  };
  const createdIssue = {
    number: 42,
    state: "open",
    title: "[QUEUE-JOB] mission-1 / cell-1",
    user: { login: "github-actions[bot]" },
    body: JSON.stringify({
      schema_version: 1,
      producer: "continuous_queue_refill_v2",
      job_type: task.job_type,
      sensitivity: "public",
      payload: task.payload,
    }),
  };
  assert.equal(
    reconcilePlanState(recoverablePlan, [createdIssue], { authorizedOwner: "owner", nowMs }),
    true,
  );
  assert.equal(recoverablePlan.issued.get(key).issue_number, 42);
  assert.throws(
    () => reconcilePlanState(
      { tasks: [task], issued: new Map() },
      [createdIssue, { ...createdIssue, number: 43 }],
      { authorizedOwner: "owner", nowMs },
    ),
    /ambiguous_task_history/,
  );
  assert.throws(
    () => reconcilePlanState(
      {
        tasks: [task],
        issued: new Map([[key, {
          issue_number: 42,
          reserved_at_utc: "2026-08-26T08:59:00.000Z",
        }]]),
      },
      [createdIssue, { ...createdIssue, number: 43 }],
      { authorizedOwner: "owner", nowMs },
    ),
    /ambiguous_task_history/,
  );
  assert.throws(
    () => assertNoDuplicateQueueTaskKeys(
      [createdIssue, { ...createdIssue, number: 43 }],
      "owner",
    ),
    /ambiguous_open_queue_task_identity/,
  );
});

test("every dispatch record requires a canonical non-future reservation timestamp", () => {
  const planBody = (reservedAt) => JSON.stringify({
    schema_version: 1,
    sensitivity: "public",
    plan_id: "plan-1",
    tasks: [{
      job_type: "heartbeat_probe",
      payload: { mission_id: "mission-1", route_id: "route-1", cell_id: "cell-1" },
    }],
    dispatch_state: {
      schema_version: 1,
      issued: {
        "heartbeat_probe|mission-1|route-1|cell-1": {
          issue_number: 42,
          reserved_at_utc: reservedAt,
        },
      },
    },
  });
  const issue = {
    number: 7,
    title: "[QUEUE-PLAN] timestamp",
    user: { login: "owner" },
  };
  assert.throws(
    () => parsePlanIssue({ ...issue, body: planBody("arbitrary covert text") }, "owner"),
    /invalid_reservation_timestamp/,
  );
  const plan = parsePlanIssue(
    { ...issue, body: planBody("2026-08-26T10:00:00.000Z") },
    "owner",
  );
  assert.throws(
    () => reconcilePlanState(plan, [], {
      authorizedOwner: "owner",
      nowMs: Date.parse("2026-08-26T09:00:00.000Z"),
    }),
    /invalid_reservation_timestamp/,
  );
});

test("sustained task identity binds probe and hold duration", () => {
  const basePayload = {
    mission_id: "mission-1",
    route_id: "route-1",
    cell_id: "cell-1",
  };
  const requested = validateTaskSpec({
    job_type: "sustained_rhythm_verification",
    payload: { ...basePayload, probe: "async_contract", hold_ms: 120000 },
  }, { requireCanonical: true });
  const historical = validateTaskSpec({
    job_type: "sustained_rhythm_verification",
    payload: { ...basePayload, probe: "runtime_syntax", hold_ms: 90000 },
  }, { requireCanonical: true });
  assert.notEqual(taskKey(requested), taskKey(historical));

  const historicalIssue = {
    number: 42,
    state: "closed",
    title: "[QUEUE-JOB] historical sustained task",
    user: { login: "github-actions[bot]" },
    body: JSON.stringify({
      schema_version: 1,
      producer: "continuous_queue_refill_v2",
      job_type: historical.job_type,
      sensitivity: "public",
      payload: historical.payload,
    }),
  };
  const plan = { tasks: [requested], issued: new Map() };
  assert.equal(
    reconcilePlanState(plan, [historicalIssue], {
      authorizedOwner: "owner",
      nowMs: Date.parse("2026-08-26T09:00:00.000Z"),
    }),
    false,
  );
  assert.equal(plan.issued.size, 0);
  assert.equal(
    classifyIssuedIssue(historicalIssue, taskKey(requested), [], "owner", "owner/repo"),
    "INVALID_EVIDENCE",
  );

  const historicalStatus = TERMINAL_BODY
    .replace("`heartbeat_probe`", "`sustained_rhythm_verification`")
    .replace(
      "`heartbeat_probe|mission-1|route-1|cell-1`",
      "`sustained_rhythm_verification|mission-1|route-1|cell-1|runtime_syntax|90000`",
    );
  assert.equal(
    hasAuthenticTerminalStatus(
      [{ user: { login: "github-actions[bot]" }, body: historicalStatus }],
      { issueNumber: 42, ...requested },
      "owner/repo",
    ),
    false,
  );
});

test("unverified history cannot complete a finite plan", () => {
  const task = validateTaskSpec({
    job_type: "heartbeat_probe",
    payload: {
      mission_id: "mission-1",
      route_id: "route-1",
      cell_id: "cell-1",
    },
  }, { requireCanonical: true });
  const key = taskKey(task);
  const issue = {
    number: 42,
    state: "closed",
    title: "[QUEUE-JOB] mission-1 / cell-1",
    user: { login: "github-actions[bot]" },
    body: JSON.stringify({
      schema_version: 1,
      producer: "continuous_queue_refill_v2",
      job_type: task.job_type,
      sensitivity: "public",
      payload: task.payload,
    }),
  };
  assert.equal(
    classifyIssuedIssue(
      issue,
      key,
      [{ user: { login: "external-user" }, body: TERMINAL_BODY }],
      "owner",
      "owner/repo",
    ),
    "UNVERIFIED",
  );
  assert.equal(
    planCompletionVerified(
      { tasks: [task] },
      [],
      {
        activeOrUnverified: 0,
        terminalSucceeded: 0,
        terminalFailed: 0,
        terminalRejected: 0,
        invalidEvidence: 0,
      },
    ),
    false,
  );
  assert.equal(
    classifyIssuedIssue(
      issue,
      key,
      [{ user: { login: "github-actions[bot]" }, body: TERMINAL_BODY }],
      "owner",
      "owner/repo",
    ),
    "TERMINAL_SUCCEEDED",
  );
  assert.equal(
    classifyIssuedIssue(
      issue,
      key,
      [{ user: { login: "github-actions[bot]" }, body: terminalBody({ state: "FAILED" }) }],
      "owner",
      "owner/repo",
    ),
    "TERMINAL_FAILED",
  );
  assert.equal(
    authenticTerminalState(
      { user: { login: "github-actions[bot]" }, body: terminalBody({ state: "REJECTED" }) },
      STATUS_JOB,
      "owner/repo",
    ),
    "REJECTED",
  );
  assert.equal(
    planCompletionVerified(
      { tasks: [task] },
      [],
      {
        activeOrUnverified: 0,
        terminalSucceeded: 0,
        terminalFailed: 1,
        terminalRejected: 0,
        invalidEvidence: 0,
      },
    ),
    false,
  );
  const legacyIssue = {
    ...issue,
    body: JSON.stringify({
      schema_version: 1,
      producer: "continuous_queue_refill_v1",
      job_type: task.job_type,
      sensitivity: "public",
      payload: task.payload,
    }),
  };
  assert.equal(
    classifyIssuedIssue(legacyIssue, key, [], "owner", "owner/repo"),
    "INVALID_EVIDENCE",
  );
  assert.equal(
    planTerminalOutcome(
      { tasks: [task] },
      [],
      {
        activeOrUnverified: 0,
        terminalSucceeded: 0,
        terminalFailed: 0,
        terminalRejected: 0,
        invalidEvidence: 1,
      },
    ),
    "FAILED",
  );
  const succeededInspection = {
    activeOrUnverified: 0,
    terminalSucceeded: 1,
    terminalFailed: 0,
    terminalRejected: 0,
    invalidEvidence: 0,
  };
  assert.equal(planCompletionVerified({ tasks: [task] }, [], succeededInspection), true);
  assert.equal(
    planTerminalOutcome({ tasks: [task] }, [], succeededInspection),
    "COMPLETE",
  );
});
