import test from "node:test";
import assert from "node:assert/strict";

import { BRIDGE_JOB_TYPE } from "./bridge.mjs";
import { parseQueueJob, taskKey, validateTaskSpec } from "../continuous-queue/worker.mjs";

function canonicalPayload(overrides = {}) {
  return {
    mission_id: "ai109-private-bridge-canary",
    route_id: "AI-109",
    cell_id: "private-bridge-canary",
    ...overrides,
  };
}

test("bridge task accepts only complete public canonical identity", () => {
  const task = validateTaskSpec({
    job_type: BRIDGE_JOB_TYPE,
    payload: canonicalPayload(),
  });
  assert.equal(task.job_type, BRIDGE_JOB_TYPE);
  assert.deepEqual(task.canonical, canonicalPayload());
  assert.equal(taskKey(task), `${BRIDGE_JOB_TYPE}|ai109-private-bridge-canary|AI-109|private-bridge-canary`);
});

test("bridge task rejects missing canonical ids", () => {
  assert.throws(() => validateTaskSpec({
    job_type: BRIDGE_JOB_TYPE,
    payload: { mission_id: "ai109-private-bridge-canary" },
  }), /canonical_ids_must_be_complete|private_bridge_requires_canonical_ids/);
});

test("bridge task rejects mission ids that could become private paths", () => {
  for (const missionId of ["runtime/investigation", "../escape", "a..b", "with:colon", "hash#value"]) {
    assert.throws(() => validateTaskSpec({
      job_type: BRIDGE_JOB_TYPE,
      payload: canonicalPayload({ mission_id: missionId }),
    }), /invalid_private_bridge_mission_id/);
  }
});

test("bridge task rejects all non-canonical public fields", () => {
  for (const extra of [
    { payload_ref: "private://hidden" },
    { source_url: "https://private.example" },
    { private_payload: { secret: true } },
    { evidence: "not-public" },
  ]) {
    assert.throws(() => validateTaskSpec({
      job_type: BRIDGE_JOB_TYPE,
      payload: { ...canonicalPayload(), ...extra },
    }), /payload_fields_not_allowlisted/);
  }
});

test("owner-created public queue issue can carry bridge wake-up identity but no private payload", () => {
  const issue = {
    number: 109,
    title: "[QUEUE-JOB] AI-109 private bridge canary",
    user: { login: "ragrardannekjold" },
    body: JSON.stringify({
      schema_version: 1,
      job_type: BRIDGE_JOB_TYPE,
      sensitivity: "public",
      payload: canonicalPayload(),
    }),
  };
  const job = parseQueueJob(issue, "ragrardannekjold");
  assert.equal(job.issueNumber, 109);
  assert.equal(job.job_type, BRIDGE_JOB_TYPE);
  assert.deepEqual(job.payload, canonicalPayload());
});

test("public queue issue still rejects payload_ref and non-public sensitivity", () => {
  const base = {
    number: 109,
    title: "[QUEUE-JOB] AI-109 private bridge canary",
    user: { login: "ragrardannekjold" },
  };
  assert.throws(() => parseQueueJob({
    ...base,
    body: JSON.stringify({
      schema_version: 1,
      job_type: BRIDGE_JOB_TYPE,
      sensitivity: "private",
      payload: canonicalPayload(),
    }),
  }, "ragrardannekjold"), /public_queue_requires_public_sensitivity/);
  assert.throws(() => parseQueueJob({
    ...base,
    body: JSON.stringify({
      schema_version: 1,
      job_type: BRIDGE_JOB_TYPE,
      sensitivity: "public",
      payload_ref: "private://hidden",
      payload: canonicalPayload(),
    }),
  }, "ragrardannekjold"), /queue_job_fields_not_allowlisted|private_payload_ref_not_enabled/);
});
