import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWorkflowHealth,
  incidentFingerprint,
  parseIncidentIssue,
  planIncidentActions,
  renderIncidentBody,
  renderIncidentTitle,
  validateLivenessContracts,
} from "./sentinel.mjs";

const REPOSITORY = "owner/repo";
const NOW = new Date("2026-08-26T12:00:00.000Z");
const PATH = ".github/workflows/example.yml";
const NAME = "Example Workflow";
const BLOB = "a".repeat(40);
const BOT = { login: "github-actions[bot]", type: "Bot" };

function contract(overrides = {}) {
  return {
    workflow_path: PATH,
    workflow_name: NAME,
    workflow_blob_sha: BLOB,
    mode: "scheduled",
    enabled_since: "2026-08-26T10:00:00.000Z",
    expected_event: "schedule",
    cadence_ms: 5 * 60_000,
    freshness_ttl_ms: 15 * 60_000,
    grace_ms: 5 * 60_000,
    recovery_min_successes: 2,
    ...overrides,
  };
}

function inventory(overrides = {}) {
  return {
    workflow_id: 100,
    workflow_name: NAME,
    workflow_path: PATH,
    workflow_url: "https://github.com/owner/repo/actions/workflows/example.yml",
    workflow_state: "active",
    workflow_blob_sha: BLOB,
    ...overrides,
  };
}

function run(overrides = {}) {
  const id = overrides.id || 10;
  const createdAt = overrides.created_at || "2026-08-26T11:55:00.000Z";
  return {
    id,
    run_attempt: 1,
    workflow_id: 100,
    workflow_name: NAME,
    workflow_path: PATH,
    workflow_url: "https://github.com/owner/repo/actions/workflows/example.yml",
    head_sha: "c".repeat(40),
    workflow_blob_sha_at_run: BLOB,
    status: "completed",
    conclusion: "success",
    event: "schedule",
    created_at: createdAt,
    run_started_at: overrides.run_started_at || createdAt,
    updated_at: "2026-08-26T11:56:00.000Z",
    html_url: "https://github.com/owner/repo/actions/runs/" + id,
    ...overrides,
  };
}

function classify({
  now = NOW,
  contracts = [contract()],
  workflows = [inventory()],
  all = [],
  scheduled = [],
  ...options
} = {}) {
  return classifyWorkflowHealth({
    repository: REPOSITORY,
    now,
    workflowInventory: workflows,
    livenessContracts: contracts,
    allEventRuns: all,
    scheduledRuns: scheduled,
    ...options,
  });
}

function axis(result, name) {
  return result.workflow_observations[0][name];
}

function openFromSignal(signal, number = 9, options = {}) {
  const body = renderIncidentBody(signal, options);
  return parseIncidentIssue({ number, state: "open", user: BOT, title: renderIncidentTitle(signal), body }, { repository: REPOSITORY });
}

test("coverage is exact across contract path, name, active state, and pinned blob", () => {
  assert.equal(classify().coverage.complete, true);
  assert.throws(() => classify({ workflows: [] }), /contract_inventory_path_mismatch/);
  assert.throws(() => classify({ contracts: [] }), /invalid_liveness_contracts/);
  assert.throws(() => classify({ workflows: [inventory({ workflow_name: "Renamed" })] }), /contract_inventory_name_mismatch/);
  assert.throws(() => classify({ workflows: [inventory({ workflow_blob_sha: "b".repeat(40) })] }), /contract_inventory_blob_mismatch/);
  const disabled = classify({ workflows: [inventory({ workflow_state: "disabled_manually" })] });
  assert.equal(axis(disabled, "execution").incident_class, "workflow_disabled");
  assert.equal(axis(disabled, "schedule_liveness").incident_class, "workflow_disabled");
  assert.equal(disabled.overall_state, "RED");
});

test("scheduled contracts require the schedule event and at least two recovery pulses", () => {
  assert.throws(() => validateLivenessContracts([contract({ expected_event: "issues" })]), /invalid_scheduled_expected_event/);
  assert.throws(() => validateLivenessContracts([contract({ recovery_min_successes: 1 })]), /contract_recovery_quorum_below_two/);
  assert.throws(() => validateLivenessContracts([contract(), contract()]), /duplicate_liveness_contract_path/);
});

test("an active scheduled workflow with no runs becomes visible missing_expected_run", () => {
  const result = classify();
  const liveness = axis(result, "schedule_liveness");
  assert.equal(liveness.phase, "ACTIVE");
  assert.equal(liveness.state, "ACTIVE_FAILURE");
  assert.equal(liveness.incident_class, "missing_expected_run");
  assert.equal(result.overall_state, "RED");
  const plan = planIncidentActions(result.signals, []);
  assert.equal(plan.upserts.length, 1);
  assert.equal(plan.upserts[0].signal.axis, "scheduled_liveness");
  assert.equal(plan.closes.length, 0);
});

test("a scheduled workflow inside its activation TTL stays unknown and cannot close", () => {
  const result = classify({
    now: new Date("2026-08-26T10:10:00.000Z"),
    contracts: [contract({ enabled_since: "2026-08-26T10:00:00.000Z" })],
  });
  assert.equal(axis(result, "schedule_liveness").state, "UNKNOWN");
  assert.deepEqual(planIncidentActions(result.signals, []), { upserts: [], closes: [] });
  assert.equal(result.overall_state, "AMBER");
});

test("a 79-minute-old success is STALE_SUCCESS even when updated_at is recent", () => {
  const stale = run({
    created_at: "2026-08-26T10:41:00.000Z",
    updated_at: "2026-08-26T11:59:00.000Z",
  });
  const result = classify({ all: [stale], scheduled: [stale] });
  const liveness = axis(result, "schedule_liveness");
  assert.equal(liveness.state, "STALE_SUCCESS");
  assert.equal(liveness.phase, "ACTIVE");
  assert.notEqual(liveness.state, "HEALTHY");
  assert.notEqual(liveness.state, "RECOVERED_INCIDENT");
});

test("a recent issue success cannot refresh stale scheduled liveness", () => {
  const staleSchedule = run({ id: 11, created_at: "2026-08-26T11:00:00.000Z", updated_at: "2026-08-26T11:01:00.000Z" });
  const issueSuccess = run({ id: 12, event: "issues", created_at: "2026-08-26T11:58:00.000Z", updated_at: "2026-08-26T11:59:00.000Z" });
  const result = classify({ all: [issueSuccess, staleSchedule], scheduled: [staleSchedule] });
  assert.equal(axis(result, "execution").state, "HEALTHY");
  assert.equal(axis(result, "schedule_liveness").state, "STALE_SUCCESS");
  assert.equal(result.overall_state, "RED");
});

test("fresh schedule quorum cannot hide a newer mixed-trigger execution failure", () => {
  const pulse1 = run({ id: 11, created_at: "2026-08-26T11:50:00.000Z", updated_at: "2026-08-26T11:51:00.000Z" });
  const pulse2 = run({ id: 12, created_at: "2026-08-26T11:55:00.000Z", updated_at: "2026-08-26T11:56:00.000Z" });
  const issueFailure = run({ id: 13, event: "issues", conclusion: "failure", created_at: "2026-08-26T11:57:00.000Z", updated_at: "2026-08-26T11:58:00.000Z" });
  const result = classify({ all: [issueFailure, pulse2, pulse1], scheduled: [pulse2, pulse1] });
  assert.equal(axis(result, "execution").state, "ACTIVE_FAILURE");
  assert.equal(axis(result, "schedule_liveness").state, "FRESH");
  assert.equal(result.overall_state, "RED");
  const executionOpen = openFromSignal(axis(result, "execution"));
  const plan = planIncidentActions(result.signals, [executionOpen]);
  assert.equal(plan.closes.length, 0);
});

test("skipped and neutral schedule records never count as recovery pulses", () => {
  for (const conclusion of ["skipped", "neutral"]) {
    const latest = run({ id: 12, conclusion, created_at: "2026-08-26T11:55:00.000Z" });
    const success = run({ id: 11, created_at: "2026-08-26T11:50:00.000Z" });
    const result = classify({ all: [latest, success], scheduled: [latest, success] });
    assert.equal(axis(result, "schedule_liveness").state, "RECOVERY_PENDING");
    assert.equal(axis(result, "schedule_liveness").healthy_pulse_streak, 0);
    assert.equal(planIncidentActions(result.signals, []).closes.length, 0);
  }
});

test("LONG_SILENCE to ONE_GREEN to RELAPSE keeps one stable liveness incident", () => {
  const missing = classify();
  const missingSignal = axis(missing, "schedule_liveness");
  const openMissing = openFromSignal(missingSignal);

  const oneGreenRun = run({ id: 20, created_at: "2026-08-26T12:04:00.000Z", updated_at: "2026-08-26T12:05:00.000Z" });
  const oneGreen = classify({ now: new Date("2026-08-26T12:05:00.000Z"), all: [oneGreenRun], scheduled: [oneGreenRun] });
  const pending = axis(oneGreen, "schedule_liveness");
  assert.equal(pending.state, "RECOVERY_PENDING");
  assert.equal(pending.fingerprint, missingSignal.fingerprint);
  const pendingPlan = planIncidentActions(oneGreen.signals, [openMissing]);
  assert.equal(pendingPlan.upserts[0].action, "UPDATE");
  assert.equal(pendingPlan.closes.length, 0);

  const pendingBody = renderIncidentBody(pending, {
    occurrences: openMissing.occurrences,
    firstSeenAt: openMissing.first_seen_at,
    existingIncident: openMissing,
  });
  const openPending = parseIncidentIssue({ number: 9, state: "open", user: BOT, title: renderIncidentTitle(pending), body: pendingBody }, { repository: REPOSITORY });
  const relapse = classify({ now: new Date("2026-08-26T12:20:00.000Z"), all: [oneGreenRun], scheduled: [oneGreenRun] });
  const stale = axis(relapse, "schedule_liveness");
  assert.equal(stale.state, "STALE_SUCCESS");
  assert.equal(stale.fingerprint, missingSignal.fingerprint);
  const relapsePlan = planIncidentActions(relapse.signals, [openPending]);
  assert.equal(relapsePlan.upserts[0].action, "UPDATE");
  assert.equal(relapsePlan.closes.length, 0);
});

test("two distinct fresh schedule successes close only the exact liveness fingerprint", () => {
  const older = run({ id: 30, created_at: "2026-08-26T11:50:00.000Z", updated_at: "2026-08-26T11:51:00.000Z" });
  const newer = run({ id: 31, created_at: "2026-08-26T11:55:00.000Z", updated_at: "2026-08-26T11:56:00.000Z" });
  const fresh = classify({ all: [newer, older], scheduled: [newer, older] });
  const liveness = axis(fresh, "schedule_liveness");
  assert.equal(liveness.state, "FRESH");
  const oldStale = classify({
    now: new Date("2026-08-26T11:45:00.000Z"),
    all: [run({ id: 1, created_at: "2026-08-26T11:20:00.000Z", updated_at: "2026-08-26T11:21:00.000Z" })],
    scheduled: [run({ id: 1, created_at: "2026-08-26T11:20:00.000Z", updated_at: "2026-08-26T11:21:00.000Z" })],
  });
  const livenessOpen = openFromSignal(axis(oldStale, "schedule_liveness"), 9);
  const executionFailure = classify({
    now: new Date("2026-08-26T11:45:00.000Z"),
    all: [run({ id: 2, event: "issues", conclusion: "failure", created_at: "2026-08-26T11:40:00.000Z", updated_at: "2026-08-26T11:41:00.000Z" })],
    scheduled: [],
  });
  const executionOpen = {
    ...openFromSignal(axis(executionFailure, "execution"), 10),
    evidence_at: "2026-08-26T11:59:00.000Z",
    latest_run_id: 99,
  };
  const plan = planIncidentActions(fresh.signals, [livenessOpen, executionOpen]);
  assert.deepEqual(plan.closes.map((item) => item.issue_number), [9]);
});

test("a rerun representation of one run ID cannot refresh recovery", () => {
  const attempt1 = run({ id: 40, run_attempt: 1, created_at: "2026-08-26T11:55:00.000Z" });
  const attempt2 = run({ id: 40, run_attempt: 2, created_at: "2026-08-26T11:55:00.000Z" });
  const result = classify({ all: [attempt1, attempt2], scheduled: [attempt1, attempt2] });
  assert.equal(axis(result, "schedule_liveness").state, "UNKNOWN");
  assert.equal(axis(result, "schedule_liveness").incident_class, "scheduled_rerun_not_liveness_evidence");
  assert.equal(axis(result, "schedule_liveness").healthy_pulse_streak, null);
});

test("event-driven workflows have no schedule axis and no history stays visible UNKNOWN", () => {
  const eventContract = contract({
    mode: "event_driven", expected_event: null, cadence_ms: null,
    freshness_ttl_ms: null, grace_ms: null, recovery_min_successes: 0,
  });
  const result = classify({ contracts: [eventContract] });
  assert.equal(axis(result, "schedule_liveness"), null);
  assert.equal(axis(result, "execution").state, "UNKNOWN");
  assert.equal(result.overall_state, "AMBER");
  assert.deepEqual(planIncidentActions(result.signals, []), { upserts: [], closes: [] });
});

test("explicit decommission closes only exact canonical Sentinel fingerprints", () => {
  const active = classify();
  const executionOpen = openFromSignal(axis(active, "execution"), 20);
  const livenessOpen = openFromSignal(axis(active, "schedule_liveness"), 21);
  const decommissionContract = contract({
    mode: "decommissioned", expected_event: null, cadence_ms: null,
    freshness_ttl_ms: null, grace_ms: null, recovery_min_successes: 0,
  });
  const retired = classify({ contracts: [decommissionContract], workflows: [inventory({ workflow_state: "disabled_manually" })] });
  const plan = planIncidentActions(retired.signals, [executionOpen, livenessOpen]);
  assert.deepEqual(plan.closes.map((item) => item.resolution), ["DECOMMISSIONED", "DECOMMISSIONED"]);
});

test("fingerprints are stable by repository, path, and axis rather than workflow ID", () => {
  const first = classify();
  const second = classify({ workflows: [inventory({ workflow_id: 999 })] });
  assert.equal(axis(first, "schedule_liveness").fingerprint, axis(second, "schedule_liveness").fingerprint);
  assert.notEqual(
    incidentFingerprint(REPOSITORY, PATH, "execution_health"),
    incidentFingerprint(REPOSITORY, PATH, "scheduled_liveness"),
  );
});

test("forged markers are ignored and duplicate canonical incidents fail closed", () => {
  const result = classify();
  const active = axis(result, "schedule_liveness");
  const validBody = renderIncidentBody(active);
  const forgedBody = validBody.replace(active.fingerprint, "gha:v3:" + "f".repeat(32));
  assert.equal(parseIncidentIssue({ number: 1, user: BOT, title: renderIncidentTitle(active), body: forgedBody }, { repository: REPOSITORY }), null);
  assert.equal(parseIncidentIssue({ number: 1, user: { login: "attacker", type: "User" }, title: renderIncidentTitle(active), body: validBody }, { repository: REPOSITORY }), null);
  const first = openFromSignal(active, 2);
  const second = openFromSignal(active, 3);
  assert.throws(() => planIncidentActions(result.signals, [first, second]), /duplicate_canonical_incident/);
});

test("clear evidence must be newer than the exact open incident", () => {
  const older = run({ id: 50, created_at: "2026-08-26T11:50:00.000Z" });
  const newer = run({ id: 51, created_at: "2026-08-26T11:55:00.000Z" });
  const fresh = classify({ all: [newer, older], scheduled: [newer, older] });
  const clear = axis(fresh, "schedule_liveness");
  const open = {
    ...openFromSignal(clear, 30),
    evidence_at: "2026-08-26T11:59:00.000Z",
    latest_run_id: 99,
    evidence_digest: "b".repeat(64),
  };
  assert.equal(planIncidentActions(fresh.signals, [open]).closes.length, 0);
});

test("resolved rendering preserves original fingerprint, class, and first-seen provenance", () => {
  const missing = classify();
  const active = axis(missing, "schedule_liveness");
  const open = openFromSignal(active, 40);
  const success1 = run({ id: 60, created_at: "2026-08-26T12:05:00.000Z" });
  const success2 = run({ id: 61, created_at: "2026-08-26T12:10:00.000Z" });
  const fresh = classify({ now: new Date("2026-08-26T12:11:00.000Z"), all: [success2, success1], scheduled: [success2, success1] });
  const clear = axis(fresh, "schedule_liveness");
  const body = renderIncidentBody(clear, {
    occurrences: open.occurrences,
    firstSeenAt: open.first_seen_at,
    resolution: "RECOVERED",
    existingIncident: open,
  });
  assert.match(body, new RegExp(open.fingerprint.replaceAll(":", "\\:")));
  assert.match(body, /incident_class: missing_expected_run/);
  assert.match(body, new RegExp("first_seen_utc: " + open.first_seen_at.replaceAll(".", "\\.")));
  assert.doesNotMatch(body, /fingerprint: resolved/);
});

test("public issue rendering excludes private run fields", () => {
  const failure = run({ conclusion: "failure", actor: { login: "private-user" }, head_commit: { message: "private message" } });
  const result = classify({ all: [failure], scheduled: [failure] });
  const active = axis(result, "execution");
  const title = renderIncidentTitle(active);
  const body = renderIncidentBody(active);
  assert.match(title, /^\[ANOMALY\]/);
  assert.match(body, /mailbox_or_private_content_published: false/);
  assert.doesNotMatch(body, /private-user|private message|@/);
  const parsed = parseIncidentIssue({ number: 9, user: BOT, title: renderIncidentTitle(active), body }, { repository: REPOSITORY });
  assert.equal(parsed.fingerprint, active.fingerprint);
});

test("future run timestamps and run/inventory identity mismatches fail closed", () => {
  const future = run({ created_at: "2026-08-26T12:10:01.000Z", updated_at: "2026-08-26T12:10:01.000Z" });
  assert.throws(() => classify({ all: [future], scheduled: [future] }), /run_timestamp_in_future/);
  const mismatched = run({ workflow_path: ".github/workflows/other.yml" });
  assert.throws(() => classify({ all: [mismatched] }), /run_workflow_identity_mismatch/);
});

test("readback counts stale and pending states and never calls them green", () => {
  const one = run();
  const pending = classify({ all: [one], scheduled: [one] });
  assert.equal(pending.state_counts.RECOVERY_PENDING, 1);
  assert.equal(pending.overall_state, "AMBER");
  const staleRun = run({ created_at: "2026-08-26T11:00:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  assert.equal(stale.state_counts.STALE_SUCCESS, 1);
  assert.equal(stale.overall_state, "RED");
});

test("a newer issue success cannot mask a fresh failed scheduled execution", () => {
  const scheduledFailure = run({
    id: 70,
    conclusion: "failure",
    created_at: "2026-08-26T11:50:00.000Z",
    updated_at: "2026-08-26T11:51:00.000Z",
  });
  const issueSuccess = run({
    id: 71,
    event: "issues",
    created_at: "2026-08-26T11:55:00.000Z",
    updated_at: "2026-08-26T11:56:00.000Z",
  });
  const result = classify({ all: [issueSuccess, scheduledFailure], scheduled: [scheduledFailure] });
  assert.equal(axis(result, "execution").state, "RECOVERED_INCIDENT");
  assert.equal(axis(result, "schedule_liveness").phase, "ACTIVE");
  assert.equal(axis(result, "schedule_liveness").incident_class, "scheduled_workflow_failure");
  assert.equal(result.overall_state, "RED");
});

test("older transient evidence cannot roll an incident backward or close a newer failure", () => {
  const newestFailure = run({
    id: 90,
    event: "issues",
    conclusion: "failure",
    created_at: "2026-08-26T11:58:00.000Z",
    updated_at: "2026-08-26T11:59:00.000Z",
  });
  const newest = classify({ all: [newestFailure], scheduled: [] });
  const open = openFromSignal(axis(newest, "execution"), 90);
  const olderFailure = run({
    id: 80,
    event: "issues",
    conclusion: "failure",
    created_at: "2026-08-26T11:00:00.000Z",
    updated_at: "2026-08-26T11:01:00.000Z",
  });
  const older = classify({ all: [olderFailure], scheduled: [] });
  const olderPlan = planIncidentActions(older.signals, [open]);
  assert.equal(olderPlan.upserts.some((action) => action.signal.fingerprint === open.fingerprint), false);
  assert.equal(olderPlan.closes.some((action) => action.signal.fingerprint === open.fingerprint), false);
  const olderSuccess = run({
    id: 89,
    event: "issues",
    created_at: "2026-08-26T11:55:00.000Z",
    updated_at: "2026-08-26T11:56:00.000Z",
  });
  const apparentRecovery = classify({ all: [olderSuccess], scheduled: [] });
  assert.equal(
    planIncidentActions(apparentRecovery.signals, [open]).closes
      .some((action) => action.signal.fingerprint === open.fingerprint),
    false,
  );
});

test("conflicting records for one run id and attempt fail closed", () => {
  const success = run({ id: 100, run_attempt: 1 });
  const failure = run({ id: 100, run_attempt: 1, conclusion: "failure" });
  assert.throws(() => classify({ all: [success, failure], scheduled: [success] }), /conflicting_duplicate_run_record/);
});

test("future-dated success and zero-spacing pulses cannot certify recovery", () => {
  const future1 = run({ id: 101, created_at: "2026-08-26T12:03:00.000Z", updated_at: "2026-08-26T12:03:00.000Z" });
  const future2 = run({ id: 102, created_at: "2026-08-26T12:04:00.000Z", updated_at: "2026-08-26T12:04:00.000Z" });
  const future = classify({ all: [future2, future1], scheduled: [future2, future1] });
  assert.equal(axis(future, "execution").state, "UNKNOWN");
  assert.equal(axis(future, "schedule_liveness").state, "UNKNOWN");
  assert.equal(future.overall_state, "AMBER");

  const sameTime1 = run({ id: 103, created_at: "2026-08-26T11:55:00.000Z" });
  const sameTime2 = run({ id: 104, created_at: "2026-08-26T11:55:00.000Z" });
  const sameTime = classify({ all: [sameTime2, sameTime1], scheduled: [sameTime2, sameTime1] });
  assert.equal(axis(sameTime, "schedule_liveness").state, "RECOVERY_PENDING");
  assert.equal(axis(sameTime, "schedule_liveness").healthy_pulse_streak, 1);
});

test("a successful higher attempt of the same run can resolve its exact execution incident", () => {
  const failedAttempt = run({
    id: 110,
    run_attempt: 1,
    event: "issues",
    conclusion: "failure",
    created_at: "2026-08-26T11:50:00.000Z",
    updated_at: "2026-08-26T11:51:00.000Z",
  });
  const failed = classify({ all: [failedAttempt], scheduled: [] });
  const open = openFromSignal(axis(failed, "execution"), 110);
  const successfulAttempt = run({
    id: 110,
    run_attempt: 2,
    event: "issues",
    created_at: "2026-08-26T11:50:00.000Z",
    updated_at: "2026-08-26T11:56:00.000Z",
  });
  const recovered = classify({ all: [successfulAttempt], scheduled: [] });
  assert.equal(planIncidentActions(recovered.signals, [open]).closes.length, 1);
});

test("recovery keeps a cadence-contiguous success chain while only the latest pulse must be inside TTL", () => {
  const latest = run({ id: 120, created_at: "2026-08-26T11:46:00.000Z" });
  const supporting = run({ id: 119, created_at: "2026-08-26T11:36:00.000Z" });
  const result = classify({ all: [latest, supporting], scheduled: [latest, supporting] });
  assert.equal(axis(result, "schedule_liveness").state, "FRESH");
  assert.equal(axis(result, "schedule_liveness").healthy_pulse_streak, 2);
});

test("workflow source mismatch is an active incident on both monitored axes", () => {
  const mismatched = run({ workflow_blob_sha_at_run: "b".repeat(40) });
  const result = classify({ all: [mismatched], scheduled: [mismatched] });
  assert.equal(axis(result, "execution").incident_class, "workflow_source_mismatch");
  assert.equal(axis(result, "execution").phase, "ACTIVE");
  assert.equal(axis(result, "schedule_liveness").incident_class, "workflow_source_mismatch");
  assert.equal(axis(result, "schedule_liveness").phase, "ACTIVE");
  assert.equal(result.overall_state, "RED");
});

test("near-simultaneous scheduled successes cannot fake a sustained quorum", () => {
  const older = run({ id: 301, created_at: "2026-08-26T11:54:59.000Z" });
  const newer = run({ id: 302, created_at: "2026-08-26T11:55:00.000Z" });
  const result = classify({ all: [newer, older], scheduled: [newer, older] });
  assert.equal(axis(result, "schedule_liveness").state, "RECOVERY_PENDING");
  assert.equal(axis(result, "schedule_liveness").healthy_pulse_streak, 1);
});

test("a same-attempt completion can supersede its stale in-progress incident", () => {
  const eventContract = contract({
    mode: "event_driven",
    expected_event: null,
    cadence_ms: null,
    freshness_ttl_ms: null,
    grace_ms: null,
    recovery_min_successes: 0,
  });
  const running = run({
    id: 310,
    event: "push",
    status: "in_progress",
    conclusion: null,
    created_at: "2026-08-26T11:00:00.000Z",
    run_started_at: "2026-08-26T11:00:00.000Z",
    updated_at: "2026-08-26T11:31:00.000Z",
  });
  const active = classify({ contracts: [eventContract], all: [running] });
  const open = openFromSignal(axis(active, "execution"), 310);
  const completed = run({
    ...running,
    status: "completed",
    conclusion: "success",
    updated_at: "2026-08-26T11:59:00.000Z",
  });
  const clear = classify({ contracts: [eventContract], all: [completed] });
  const plan = planIncidentActions(clear.signals, [open]);
  assert.equal(plan.closes.length, 1);
  assert.equal(plan.closes[0].signal.evidence_revision_at, "2026-08-26T11:59:00.000Z");
});

test("a later-started rerun dominates a newer original run on execution health only", () => {
  const originalSuccess = run({
    id: 320,
    event: "push",
    created_at: "2026-08-26T11:55:00.000Z",
    run_started_at: "2026-08-26T11:55:00.000Z",
    updated_at: "2026-08-26T11:56:00.000Z",
  });
  const oldRerunFailure = run({
    id: 319,
    run_attempt: 2,
    event: "push",
    conclusion: "failure",
    created_at: "2026-08-26T10:00:00.000Z",
    run_started_at: "2026-08-26T11:58:00.000Z",
    updated_at: "2026-08-26T11:59:00.000Z",
  });
  const result = classify({ all: [originalSuccess, oldRerunFailure], scheduled: [] });
  assert.equal(axis(result, "execution").latest_run_id, 319);
  assert.equal(axis(result, "execution").phase, "ACTIVE");
  assert.equal(axis(result, "schedule_liveness").incident_class, "missing_expected_run");
});

test("a scheduled rerun never counts as a new recovery pulse", () => {
  const original = run({ id: 330, created_at: "2026-08-26T11:50:00.000Z" });
  const rerun = run({
    id: 331,
    run_attempt: 2,
    created_at: "2026-08-26T11:55:00.000Z",
    run_started_at: "2026-08-26T11:59:00.000Z",
  });
  const result = classify({ all: [rerun, original], scheduled: [rerun, original] });
  assert.equal(axis(result, "schedule_liveness").state, "UNKNOWN");
  assert.equal(axis(result, "schedule_liveness").incident_class, "scheduled_rerun_not_liveness_evidence");
  assert.equal(axis(result, "schedule_liveness").healthy_pulse_streak, null);
});

test("a recent failed rerun is execution evidence, not a scheduler failure pulse", () => {
  const rerunFailure = run({ run_attempt: 2, conclusion: "failure" });
  const result = classify({ all: [rerunFailure], scheduled: [rerunFailure] });
  assert.equal(axis(result, "execution").phase, "ACTIVE");
  assert.equal(axis(result, "schedule_liveness").phase, "HOLD");
  assert.equal(axis(result, "schedule_liveness").incident_class, "scheduled_rerun_not_liveness_evidence");
});

test("GitHub stale conclusion is an active failure rather than a quiet hold", () => {
  const staleConclusion = run({ conclusion: "stale" });
  const result = classify({ all: [staleConclusion], scheduled: [staleConclusion] });
  assert.equal(axis(result, "execution").phase, "ACTIVE");
  assert.equal(axis(result, "execution").incident_class, "workflow_stale");
  assert.equal(axis(result, "schedule_liveness").phase, "ACTIVE");
  assert.equal(axis(result, "schedule_liveness").incident_class, "scheduled_workflow_stale");
});

test("future-dated canonical incident provenance cannot suppress a genuine update", () => {
  const failure = run({ conclusion: "failure", updated_at: "2026-08-26T11:40:00.000Z" });
  const active = classify({ all: [failure], scheduled: [failure] });
  const signal = axis(active, "schedule_liveness");
  const open = openFromSignal(signal, 600);
  const forgedFuture = {
    ...open,
    first_seen_at: "2030-01-01T00:00:00.000Z",
    last_seen_at: "2030-01-01T00:00:00.000Z",
    evidence_at: "2030-01-01T00:00:00.000Z",
    evidence_revision_at: "2030-01-01T00:00:00.000Z",
    evidence_digest: "f".repeat(64),
  };
  const plan = planIncidentActions(active.signals, [forgedFuture]);
  const update = plan.upserts.find((item) => item.signal.fingerprint === signal.fingerprint);
  assert.equal(update.action, "UPDATE");
  assert.equal(update.repair_untrusted_provenance, true);
});

test("an older scheduled snapshot never rolls a newer open incident backward", () => {
  const newerFailure = run({ id: 90, conclusion: "failure", created_at: "2026-08-26T11:58:00.000Z", updated_at: "2026-08-26T11:59:00.000Z" });
  const newer = classify({ all: [newerFailure], scheduled: [newerFailure] });
  const newerOpen = openFromSignal(axis(newer, "schedule_liveness"), 601);
  const olderFailure = run({ id: 80, conclusion: "failure", created_at: "2026-08-26T11:50:00.000Z", updated_at: "2026-08-26T11:51:00.000Z" });
  const older = classify({ all: [olderFailure], scheduled: [olderFailure] });
  const plan = planIncidentActions(older.signals, [newerOpen]);
  assert.equal(plan.upserts.some((item) => item.signal.fingerprint === newerOpen.fingerprint), false);
  assert.equal(plan.closes.some((item) => item.signal.fingerprint === newerOpen.fingerprint), false);
});

test("canonical v3 issue bodies reject duplicate or appended public claims", () => {
  const result = classify();
  const signal = axis(result, "schedule_liveness");
  const body = renderIncidentBody(signal);
  const issue = { number: 602, state: "open", user: BOT, title: renderIncidentTitle(signal) };
  assert.equal(parseIncidentIssue({ ...issue, body: body + "\n- state: **HEALTHY**" }, { repository: REPOSITORY }), null);
  assert.equal(parseIncidentIssue({ ...issue, body: body.replace("- reason: ", "- reason: forged\n- reason: ") }, { repository: REPOSITORY }), null);
});
