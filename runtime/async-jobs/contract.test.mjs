import test from "node:test";
import assert from "node:assert/strict";
import { parseJobBody, buildStatus, extractCanonicalIds } from "./contract.mjs";

test("accepts allowlisted public job", () => {
  const job = parseJobBody(JSON.stringify({
    schema_version: 1,
    job_type: "heartbeat_probe",
    sensitivity: "public",
    workload_class: "normal",
  }));
  assert.equal(job.job_type, "heartbeat_probe");
  assert.equal(job.sensitivity, "public");
});

test("accepts complete canonical IDs", () => {
  const job = parseJobBody(JSON.stringify({
    schema_version: 1,
    job_type: "intentional_failure_probe",
    sensitivity: "public",
    payload: {
      mission_id: "HYPERLOOP-TEST-001",
      route_id: "CODE-RECOVERY-01",
      cell_id: "FAILURE-CELL-01",
    },
  }));
  assert.equal(job.canonical.mission_id, "HYPERLOOP-TEST-001");
  assert.equal(job.canonical.route_id, "CODE-RECOVERY-01");
  assert.equal(job.canonical.cell_id, "FAILURE-CELL-01");
});

test("requires canonical IDs as a complete tuple", () => {
  assert.throws(() => parseJobBody(JSON.stringify({
    schema_version: 1,
    job_type: "heartbeat_probe",
    sensitivity: "public",
    payload: { mission_id: "ONLY-MISSION" },
  })), /canonical_ids_must_be_complete/);
});

test("extracts canonical IDs before allowlist rejection", () => {
  const raw = JSON.stringify({
    schema_version: 1,
    job_type: "not_allowlisted",
    sensitivity: "public",
    payload: {
      mission_id: "HYPERLOOP-TEST-002",
      route_id: "PRIMARY",
      cell_id: "CELL-A",
    },
  });
  const ids = extractCanonicalIds(raw);
  assert.equal(ids.mission_id, "HYPERLOOP-TEST-002");
  assert.throws(() => parseJobBody(raw), /job_type_not_allowlisted/);
});

test("rejects non-public payloads", () => {
  assert.throws(() => parseJobBody(JSON.stringify({
    schema_version: 1,
    job_type: "heartbeat_probe",
    sensitivity: "private",
  })), /public_runtime_requires_public_sensitivity/);
});

test("rejects unallowlisted job types", () => {
  assert.throws(() => parseJobBody(JSON.stringify({
    schema_version: 1,
    job_type: "arbitrary_shell",
    sensitivity: "public",
  })), /job_type_not_allowlisted/);
});

test("status advertises policy target and durable canonical checkpoint", () => {
  const status = buildStatus({
    repository: "owner/repo",
    issueNumber: 7,
    runId: "42",
    state: "RUNNING",
    step: "test",
    canonical: {
      mission_id: "MISSION-1",
      route_id: "ROUTE-1",
      cell_id: "CELL-1",
    },
  });
  assert.equal(status.policy_target.foreground_control_plane_max_pct, 40);
  assert.equal(status.policy_target.reserve_min_pct, 60);
  assert.equal(status.chat_blocking, false);
  assert.equal(status.mission_id, "MISSION-1");
  assert.equal(status.route_id, "ROUTE-1");
  assert.equal(status.cell_id, "CELL-1");
  assert.equal(status.checkpoint_ref, "https://github.com/owner/repo/issues/7#run-42");
});
