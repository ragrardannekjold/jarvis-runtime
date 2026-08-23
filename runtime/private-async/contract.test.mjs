import test from "node:test";
import assert from "node:assert/strict";
import { parsePublicTrigger, parsePrivateJob, JOB_REF_RE } from "./contract.mjs";

const ref = "paj-0123456789abcdef01234567";

test("opaque public trigger accepts only schema_version and job_ref", () => {
  assert.deepEqual(
    parsePublicTrigger(JSON.stringify({ schema_version: 1, job_ref: ref })),
    { schema_version: 1, job_ref: ref },
  );
});

test("public trigger rejects payload leakage fields", () => {
  assert.throws(
    () => parsePublicTrigger(JSON.stringify({ schema_version: 1, job_ref: ref, payload: { secret: true } })),
    /opaque_reference_only/,
  );
});

test("public trigger rejects descriptive metadata leakage", () => {
  assert.throws(
    () => parsePublicTrigger(JSON.stringify({ schema_version: 1, job_ref: ref, job_type: "private_integrity_probe" })),
    /opaque_reference_only/,
  );
});

test("job ref is opaque fixed-format identifier", () => {
  assert.equal(JOB_REF_RE.test(ref), true);
  assert.equal(JOB_REF_RE.test("investigation-kyiv-secret"), false);
});

test("private job accepts allowlisted private contract", () => {
  const job = parsePrivateJob({
    schema_version: 1,
    job_ref: ref,
    job_type: "private_integrity_probe",
    sensitivity: "private",
    payload: { private_canary: "value" },
  }, ref);
  assert.equal(job.job_type, "private_integrity_probe");
  assert.equal(job.sensitivity, "private");
});

test("private job accepts bounded AI-39 CYBINT type without public metadata", () => {
  const job = parsePrivateJob({
    schema_version: 1,
    job_ref: ref,
    job_type: "ai39_cybint_refresh",
    sensitivity: "private",
    payload: { asn: "AS202279", historical_reference_total: 488 },
  }, ref);
  assert.equal(job.job_type, "ai39_cybint_refresh");
  assert.equal(job.payload.asn, "AS202279");
});

test("private job accepts bounded RTO multi-AS compare type with empty payload", () => {
  const job = parsePrivateJob({
    schema_version: 1,
    job_ref: ref,
    job_type: "ai39_rto_as_compare",
    sensitivity: "private",
    payload: {},
  }, ref);
  assert.equal(job.job_type, "ai39_rto_as_compare");
  assert.deepEqual(job.payload, {});
});

test("private job rejects non-allowlisted execution", () => {
  assert.throws(
    () => parsePrivateJob({
      schema_version: 1,
      job_ref: ref,
      job_type: "arbitrary_shell",
      sensitivity: "private",
    }, ref),
    /not_allowlisted/,
  );
});

test("private job ref must match public opaque reference", () => {
  assert.throws(
    () => parsePrivateJob({
      schema_version: 1,
      job_ref: "paj-aaaaaaaaaaaaaaaaaaaaaaaa",
      job_type: "private_integrity_probe",
      sensitivity: "private",
    }, ref),
    /ref_mismatch/,
  );
});
