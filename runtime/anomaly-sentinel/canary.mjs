import assert from "node:assert/strict";
import { classifyWorkflowHealth, planIncidentActions } from "./sentinel.mjs";

const repository = "owner/repo";
const now = new Date("2026-08-26T12:00:00.000Z");
const blob = "a".repeat(40);
const specs = [
  [1, "Mixed", ".github/workflows/mixed.yml"],
  [2, "Stale", ".github/workflows/stale.yml"],
  [3, "Missing", ".github/workflows/missing.yml"],
  [4, "Pending", ".github/workflows/pending.yml"],
];

const workflowInventory = specs.map(([workflow_id, workflow_name, workflow_path]) => ({
  workflow_id,
  workflow_name,
  workflow_path,
  workflow_url: "https://github.com/owner/repo/actions/workflows/" + workflow_path.split("/").at(-1),
  workflow_state: "active",
  workflow_blob_sha: blob,
}));

const livenessContracts = specs.map(([, workflow_name, workflow_path]) => ({
  workflow_path,
  workflow_name,
  workflow_blob_sha: blob,
  mode: "scheduled",
  enabled_since: "2026-08-26T10:00:00.000Z",
  expected_event: "schedule",
  cadence_ms: 5 * 60_000,
  freshness_ttl_ms: 15 * 60_000,
  grace_ms: 5 * 60_000,
  recovery_min_successes: 2,
}));

function run(workflowId, id, overrides = {}) {
  const identity = workflowInventory.find((item) => item.workflow_id === workflowId);
  const createdAt = overrides.created_at || "2026-08-26T11:55:00.000Z";
  return {
    id,
    run_attempt: 1,
    workflow_id: workflowId,
    workflow_name: identity.workflow_name,
    workflow_path: identity.workflow_path,
    workflow_url: identity.workflow_url,
    head_sha: "c".repeat(40),
    workflow_blob_sha_at_run: blob,
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

const mixedOlder = run(1, 11, { created_at: "2026-08-26T11:50:00.000Z" });
const mixedNewer = run(1, 12);
const mixedFailure = run(1, 13, {
  event: "issues",
  conclusion: "failure",
  created_at: "2026-08-26T11:57:00.000Z",
  updated_at: "2026-08-26T11:58:00.000Z",
});
const stale = run(2, 20, {
  created_at: "2026-08-26T11:00:00.000Z",
  updated_at: "2026-08-26T11:59:00.000Z",
});
const pending = run(4, 40);

const health = classifyWorkflowHealth({
  repository,
  now,
  workflowInventory,
  livenessContracts,
  allEventRuns: [mixedFailure, mixedNewer, mixedOlder, stale, pending],
  scheduledRuns: [mixedNewer, mixedOlder, stale, pending],
});
const byName = new Map(health.workflow_observations.map((item) => [item.identity.workflow_name, item]));
assert.equal(byName.get("Mixed").execution.state, "ACTIVE_FAILURE");
assert.equal(byName.get("Mixed").schedule_liveness.state, "FRESH");
assert.equal(byName.get("Stale").schedule_liveness.state, "STALE_SUCCESS");
assert.equal(byName.get("Missing").schedule_liveness.incident_class, "missing_expected_run");
assert.equal(byName.get("Pending").schedule_liveness.state, "RECOVERY_PENDING");
assert.equal(health.overall_state, "RED");

const plan = planIncidentActions(health.signals, []);
assert.equal(plan.upserts.length, 3);
assert.equal(plan.closes.length, 0);

const receipt = {
  overall_state: health.overall_state,
  active_fingerprints: health.active_fingerprints.length,
  stale_success: health.state_counts.STALE_SUCCESS || 0,
  recovery_pending: health.state_counts.RECOVERY_PENDING || 0,
  diagnostic_would_create: plan.upserts.filter((action) => action.action === "CREATE").length,
  diagnostic_would_close: plan.closes.length,
  mutation_authority: "NONE",
};
assert.deepEqual(receipt, {
  overall_state: "RED",
  active_fingerprints: 3,
  stale_success: 1,
  recovery_pending: 1,
  diagnostic_would_create: 3,
  diagnostic_would_close: 0,
  mutation_authority: "NONE",
});
console.log("ANOMALY_SENTINEL_CANARY " + JSON.stringify(receipt));
