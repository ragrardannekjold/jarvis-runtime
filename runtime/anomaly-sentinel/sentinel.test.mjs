import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWorkflowRuns,
  incidentFingerprint,
  parseIncidentIssue,
  planIncidentActions,
  renderIncidentBody,
  renderIncidentTitle,
} from "./sentinel.mjs";

const NOW = new Date("2026-08-26T12:00:00.000Z");

function run(overrides = {}) {
  return {
    id: 10,
    workflow_id: 100,
    name: "Example Workflow",
    status: "completed",
    conclusion: "success",
    created_at: "2026-08-26T11:50:00.000Z",
    updated_at: "2026-08-26T11:55:00.000Z",
    html_url: "https://github.com/owner/repo/actions/runs/10",
    actor: { login: "private-user" },
    head_commit: { message: "private message" },
    ...overrides,
  };
}

test("classifies a mature terminal failure as active", () => {
  const [state] = classifyWorkflowRuns([run({ conclusion: "failure" })], { now: NOW });
  assert.equal(state.state, "ACTIVE_FAILURE");
  assert.equal(state.incident_class, "workflow_failure");
});

test("a newer success turns an earlier failure into recovered", () => {
  const states = classifyWorkflowRuns([
    run({ id: 11, conclusion: "success", created_at: "2026-08-26T11:56:00.000Z", updated_at: "2026-08-26T11:57:00.000Z" }),
    run({ id: 10, conclusion: "failure" }),
  ], { now: NOW });
  assert.equal(states[0].state, "RECOVERED_INCIDENT");
  assert.equal(states[0].latest_run_id, 11);
});

test("allowlisted concurrency cancellation is expected", () => {
  const [state] = classifyWorkflowRuns([
    run({ name: "Kyiv V3 public collector", conclusion: "cancelled" }),
  ], { now: NOW, expectedCancelledWorkflows: ["Kyiv V3 public collector"] });
  assert.equal(state.state, "EXPECTED_CANCEL");
});

test("unallowlisted cancellation remains unknown", () => {
  const [state] = classifyWorkflowRuns([run({ conclusion: "cancelled" })], { now: NOW });
  assert.equal(state.state, "UNKNOWN");
});

test("stale in-progress run becomes an active incident", () => {
  const [state] = classifyWorkflowRuns([
    run({ status: "in_progress", conclusion: null, created_at: "2026-08-26T10:00:00.000Z" }),
  ], { now: NOW, staleMs: 30 * 60_000 });
  assert.equal(state.state, "ACTIVE_FAILURE");
  assert.equal(state.incident_class, "stale_run");
});

test("fresh failure inside grace window stays unknown", () => {
  const [state] = classifyWorkflowRuns([
    run({ conclusion: "failure", updated_at: "2026-08-26T11:59:30.000Z" }),
  ], { now: NOW, graceMs: 60_000 });
  assert.equal(state.state, "UNKNOWN");
});

test("incident plan creates once and updates only for a new run", () => {
  const [active] = classifyWorkflowRuns([run({ conclusion: "failure" })], { now: NOW });
  assert.equal(planIncidentActions([active], []).map((item) => item.action).join(), "CREATE");
  const existing = [{
    issue_number: 7,
    workflow_id: active.workflow_id,
    fingerprint: active.fingerprint,
    latest_run_id: active.latest_run_id,
    occurrences: 1,
    first_seen_at: active.observed_at,
  }];
  assert.deepEqual(planIncidentActions([active], existing), []);
  const newer = { ...active, latest_run_id: 12, latest_run_url: "https://github.com/owner/repo/actions/runs/12" };
  const [update] = planIncidentActions([newer], existing);
  assert.equal(update.action, "UPDATE");
  assert.equal(update.occurrences, 2);
});

test("healthy state closes one existing incident", () => {
  const [healthy] = classifyWorkflowRuns([run()], { now: NOW });
  const open = [{ issue_number: 8, workflow_id: 100, fingerprint: incidentFingerprint(100, "workflow_failure") }];
  const [close] = planIncidentActions([healthy], open);
  assert.equal(close.action, "CLOSE");
  assert.equal(close.resolution, "RECOVERED");
});

test("public issue rendering excludes private and mailbox fields", () => {
  const [active] = classifyWorkflowRuns([run({ conclusion: "failure" })], { now: NOW });
  const title = renderIncidentTitle(active);
  const body = renderIncidentBody(active);
  assert.match(title, /^\[ANOMALY\]/);
  assert.match(body, /mailbox_or_private_content_published: false/);
  assert.doesNotMatch(body, /private-user|private message|@/);
  const parsed = parseIncidentIssue({ number: 9, body });
  assert.equal(parsed.issue_number, 9);
  assert.equal(parsed.fingerprint, active.fingerprint);
  assert.equal(parsed.latest_run_id, active.latest_run_id);
});

test("invalid future timestamps fail closed", () => {
  assert.throws(() => classifyWorkflowRuns([
    run({ created_at: "2026-08-26T12:10:00.000Z", updated_at: "2026-08-26T12:10:00.000Z" }),
  ], { now: NOW }), /run_timestamp_in_future/);
});
