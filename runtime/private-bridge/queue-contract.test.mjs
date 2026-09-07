import test from "node:test";
import assert from "node:assert/strict";

import { BRIDGE_JOB_TYPE } from "./bridge.mjs";
import { parseQueueJob, validateTaskSpec } from "../continuous-queue/worker.mjs";

const canonicalPayload = {
  mission_id: "ai109-private-bridge-canary",
  route_id: "AI-109",
  cell_id: "private-bridge-canary",
};

test("public continuous queue rejects the private bridge job type in CONTAIN phase", () => {
  assert.throws(
    () => validateTaskSpec({ job_type: BRIDGE_JOB_TYPE, payload: canonicalPayload }),
    /job_type_not_allowlisted/,
  );
});

test("owner-created public queue issue cannot activate the private bridge", () => {
  const issue = {
    number: 109,
    title: "[QUEUE-JOB] AI-109 private bridge canary",
    user: { login: "ragrardannekjold" },
    body: JSON.stringify({
      schema_version: 1,
      job_type: BRIDGE_JOB_TYPE,
      sensitivity: "public",
      payload: canonicalPayload,
    }),
  };
  assert.throws(
    () => parseQueueJob(issue, "ragrardannekjold"),
    /job_type_not_allowlisted/,
  );
});

test("public continuous queue baseline remains usable for an allowlisted public heartbeat", () => {
  const task = validateTaskSpec({
    job_type: "heartbeat_probe",
    payload: canonicalPayload,
  });
  assert.equal(task.job_type, "heartbeat_probe");
  assert.deepEqual(task.canonical, canonicalPayload);
});

test("public queue still rejects private sensitivity", () => {
  const issue = {
    number: 110,
    title: "[QUEUE-JOB] public heartbeat",
    user: { login: "ragrardannekjold" },
    body: JSON.stringify({
      schema_version: 1,
      job_type: "heartbeat_probe",
      sensitivity: "private",
      payload: canonicalPayload,
    }),
  };
  assert.throws(
    () => parseQueueJob(issue, "ragrardannekjold"),
    /public_queue_requires_public_sensitivity/,
  );
});

test("public queue still rejects payload_ref even for allowlisted public jobs", () => {
  const issue = {
    number: 111,
    title: "[QUEUE-JOB] public heartbeat",
    user: { login: "ragrardannekjold" },
    body: JSON.stringify({
      schema_version: 1,
      job_type: "heartbeat_probe",
      sensitivity: "public",
      payload_ref: "private://hidden",
      payload: canonicalPayload,
    }),
  };
  assert.throws(
    () => parseQueueJob(issue, "ragrardannekjold"),
    /queue_job_fields_not_allowlisted|private_payload_ref_not_enabled/,
  );
});
