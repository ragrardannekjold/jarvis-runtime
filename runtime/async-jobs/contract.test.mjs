import test from "node:test";
import assert from "node:assert/strict";
import { parseJobBody, buildStatus } from "./contract.mjs";

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

test("status advertises policy target, not measured utilization", () => {
  const status = buildStatus({
    repository: "owner/repo",
    issueNumber: 7,
    runId: "42",
    state: "RUNNING",
    step: "test",
  });
  assert.equal(status.policy_target.foreground_control_plane_max_pct, 40);
  assert.equal(status.policy_target.reserve_min_pct, 60);
  assert.equal(status.chat_blocking, false);
});
