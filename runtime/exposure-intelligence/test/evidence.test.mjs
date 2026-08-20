import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendEvidenceBatch, verifyEvidence } from "../src/evidence.mjs";
import { acquireDurableLock } from "../src/run-lock.mjs";
import { fixedNow, tempWorkspace } from "./helpers.mjs";

test("evidence is append-only, hash-chained, and redacts secrets", async () => {
  const { baseDir } = await tempWorkspace();
  const file = path.join(baseDir, "evidence", "test.ndjson");
  await appendEvidenceBatch(file, [
    { kind: "event", payload: { authorization: "Bearer secret-token", safe: "ok" } },
    { kind: "event", payload: { apiKey: "do-not-store", safe: "still-ok" } },
  ], { now: fixedNow });
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(text, /secret-token|do-not-store/);
  assert.match(text, /\[REDACTED\]/);
  assert.deepEqual(await verifyEvidence(file), {
    valid: true,
    count: 2,
    headHash: JSON.parse(text.trimEnd().split("\n").at(-1)).hash,
  });
});

test("evidence verifier detects tampering", async () => {
  const { baseDir } = await tempWorkspace();
  const file = path.join(baseDir, "evidence.ndjson");
  await appendEvidenceBatch(file, [{ kind: "event", payload: { value: 1 } }], { now: fixedNow });
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace('"value":1', '"value":2'));
  await assert.rejects(verifyEvidence(file), { code: "EVIDENCE_HASH_MISMATCH" });
});

test("a live evidence lock returns a stable actionable error", async () => {
  const { baseDir } = await tempWorkspace();
  const file = path.join(baseDir, "evidence.ndjson");
  const lock = await acquireDurableLock(`${file}.lock`, { now: fixedNow, purpose: "evidence" });
  await assert.rejects(
    appendEvidenceBatch(file, [{ kind: "event", payload: { value: 1 } }], { now: fixedNow }),
    { code: "EVIDENCE_LOCKED" },
  );
  await lock.release();
});

test("an orphan evidence lock is recovered and the append succeeds once", async () => {
  const { baseDir } = await tempWorkspace();
  const file = path.join(baseDir, "evidence.ndjson");
  const lockPath = `${file}.lock`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
    schemaVersion: 1,
    ownerToken: "dead-evidence-owner",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    heartbeatAt: "2026-08-16T12:00:00.000Z",
  }), { mode: 0o600 });
  const result = await appendEvidenceBatch(file, [{ kind: "event", payload: { value: 1 } }], { now: fixedNow });
  assert.equal(result.count, 1);
  const names = await readdir(baseDir);
  assert.equal(names.some((name) => name.startsWith("evidence.ndjson.lock.orphan-")), true);
  assert.equal(names.some((name) => name.startsWith("evidence.ndjson.lock.released-")), false);
});

test("unterminated final evidence fragment is quarantined and recovery is recorded", async () => {
  const { baseDir } = await tempWorkspace();
  const file = path.join(baseDir, "evidence.ndjson");
  await appendEvidenceBatch(file, [{ kind: "before", payload: { value: 1 } }], { now: fixedNow });
  const fragment = '{"schemaVersion":1,"seq":2';
  await appendFile(file, fragment);
  await assert.rejects(verifyEvidence(file), { code: "EVIDENCE_INVALID" });

  const result = await appendEvidenceBatch(file, [{ kind: "after", payload: { value: 2 } }], { now: fixedNow });
  assert.equal(result.count, 3);
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((entry) => entry.kind), ["before", "evidence_tail_recovered", "after"]);
  const quarantineDir = `${file}.quarantine`;
  const [quarantineName] = await readdir(quarantineDir);
  assert.equal(await readFile(path.join(quarantineDir, quarantineName), "utf8"), fragment);
  assert.equal((await stat(quarantineDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(quarantineDir, quarantineName))).mode & 0o777, 0o600);
  assert.equal((await verifyEvidence(file)).valid, true);
});

test("newline-terminated malformed evidence remains a hard failure", async () => {
  const { baseDir } = await tempWorkspace();
  const file = path.join(baseDir, "evidence.ndjson");
  await appendEvidenceBatch(file, [{ kind: "before", payload: { value: 1 } }], { now: fixedNow });
  await appendFile(file, "not-json\n");
  await assert.rejects(
    appendEvidenceBatch(file, [{ kind: "after", payload: { value: 2 } }], { now: fixedNow }),
    { code: "EVIDENCE_INVALID" },
  );
});
