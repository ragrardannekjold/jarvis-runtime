import assert from "node:assert/strict";
import { inspectPacket, sealPacket } from "./bus-core.mjs";

const now = new Date("2026-08-26T09:00:00.000Z");
const packet = sealPacket({
  schema_version: 1,
  packet_type: "knowledge",
  sensitivity: "public",
  created_at: "2026-08-26T08:55:00.000Z",
  expires_at: "2026-09-02T08:55:00.000Z",
  provenance: {
    repository: "ragrardannekjold/jarvis-runtime",
    path: "runtime/knowledge-skill-bus/README.md",
    commit_sha: "a".repeat(40),
  },
  target_modules: ["dispatcher"],
  capability: "bus.contract.validate",
  evidence_status: "verified",
  confidence: 1,
  lineage: { parent_packet_ids: [], sequence: 0 },
  observations: [{
    module_id: "dispatcher",
    status: "capability_missing",
    capability_id: "bus.private_transport",
    evidence_sha256: "b".repeat(64),
    observed_at: "2026-08-26T08:56:00.000Z",
  }],
  body: {
    title: "Bus Core canary",
    summary: "Public, deterministic, non-executing validation canary.",
    facts: ["Private transport is not enabled in v0.1."],
  },
});

const receipt = inspectPacket(packet, { now });
assert.equal(receipt.accepted, true);
assert.equal(receipt.state, "ACCEPTED");
assert.equal(receipt.gap_signals.length, 1);

console.log(`BUS_CANARY_READBACK ${JSON.stringify(receipt)}`);
