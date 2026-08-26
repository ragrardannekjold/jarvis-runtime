import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const MAX_PACKET_BYTES = 16 * 1024;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9._:/#-]{1,128}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,256}$/;
const OBSERVATION_STATES = new Set([
  "ok",
  "capability_missing",
  "verification_failed",
  "executor_unavailable",
  "source_stale",
]);

function fail(code) {
  throw new Error(code);
}

function plainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function boundedString(value, field, maxLength, { minLength = 1, pattern } = {}) {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength || value.includes("\0")) {
    fail(`invalid_${field}`);
  }
  if (pattern && !pattern.test(value)) fail(`invalid_${field}`);
  return value;
}

function parseTimestamp(value, field) {
  boundedString(value, field, 40);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`invalid_${field}`);
  return timestamp;
}

function requireSortedUnique(values, field, { min = 0, max = 32, pattern = ID_RE } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > max) fail(`invalid_${field}`);
  const normalized = values.map((value) => boundedString(value, field, 128, { pattern }));
  if (new Set(normalized).size !== normalized.length) fail(`duplicate_${field}`);
  if (normalized.some((value, index) => index > 0 && normalized[index - 1].localeCompare(value) > 0)) {
    fail(`noncanonical_${field}`);
  }
  return normalized;
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateProvenance(provenance) {
  plainObject(provenance, "invalid_provenance");
  exactKeys(provenance, ["repository", "path", "commit_sha", "content_sha256"], "invalid_provenance_keys");
  boundedString(provenance.repository, "provenance_repository", 201, { pattern: REPOSITORY_RE });
  boundedString(provenance.path, "provenance_path", 256, { pattern: SAFE_PATH_RE });
  boundedString(provenance.commit_sha, "provenance_commit_sha", 40, { pattern: COMMIT_RE });
  boundedString(provenance.content_sha256, "provenance_content_sha256", 64, { pattern: SHA256_RE });
}

function validateLineage(lineage, packetId) {
  plainObject(lineage, "invalid_lineage");
  exactKeys(lineage, ["parent_packet_ids", "sequence"], "invalid_lineage_keys");
  const parents = requireSortedUnique(lineage.parent_packet_ids, "parent_packet_ids", {
    max: 8,
    pattern: /^bus:v1:(knowledge|skill):[a-f0-9]{64}$/,
  });
  if (!Number.isInteger(lineage.sequence) || lineage.sequence < 0 || lineage.sequence > 1_000_000) {
    fail("invalid_lineage_sequence");
  }
  if ((lineage.sequence === 0) !== (parents.length === 0)) fail("invalid_lineage_root_relation");
  if (parents.includes(packetId)) fail("self_referential_lineage");
}

function observationKey(observation) {
  return [
    observation.module_id,
    observation.status,
    observation.capability_id,
    observation.evidence_sha256,
    observation.observed_at,
  ].join("|");
}

function validateObservations(observations, createdAt, expiresAt) {
  if (!Array.isArray(observations) || observations.length > 16) fail("invalid_observations");
  let prior = null;
  for (const observation of observations) {
    plainObject(observation, "invalid_observation");
    exactKeys(
      observation,
      ["module_id", "status", "capability_id", "evidence_sha256", "observed_at"],
      "invalid_observation_keys",
    );
    boundedString(observation.module_id, "observation_module_id", 128, { pattern: ID_RE });
    boundedString(observation.capability_id, "observation_capability_id", 128, { pattern: ID_RE });
    if (!OBSERVATION_STATES.has(observation.status)) fail("invalid_observation_status");
    boundedString(observation.evidence_sha256, "observation_evidence_sha256", 64, { pattern: SHA256_RE });
    const observedAt = parseTimestamp(observation.observed_at, "observation_observed_at");
    if (observedAt < createdAt - MAX_FUTURE_SKEW_MS || observedAt > expiresAt) {
      fail("observation_outside_packet_lifetime");
    }
    const key = observationKey(observation);
    if (prior !== null && prior.localeCompare(key) >= 0) fail("noncanonical_or_duplicate_observations");
    prior = key;
  }
}

function validateKnowledgeBody(body) {
  plainObject(body, "invalid_knowledge_body");
  exactKeys(body, ["title", "summary", "facts"], "invalid_knowledge_body_keys");
  boundedString(body.title, "knowledge_title", 160);
  boundedString(body.summary, "knowledge_summary", 1200);
  if (!Array.isArray(body.facts) || body.facts.length < 1 || body.facts.length > 16) fail("invalid_knowledge_facts");
  for (const fact of body.facts) boundedString(fact, "knowledge_fact", 500);
}

function validateSkillBody(body) {
  plainObject(body, "invalid_skill_body");
  exactKeys(body, ["name", "version", "entrypoint", "test_path"], "invalid_skill_body_keys");
  boundedString(body.name, "skill_name", 128, { pattern: ID_RE });
  boundedString(body.version, "skill_version", 32, { pattern: /^\d+\.\d+\.\d+$/ });
  boundedString(body.entrypoint, "skill_entrypoint", 256, { pattern: SAFE_PATH_RE });
  boundedString(body.test_path, "skill_test_path", 256, { pattern: SAFE_PATH_RE });
}

function packetIdentityInput(packet) {
  const { packet_id: _packetId, ...identity } = packet;
  return identity;
}

export function expectedPacketId(packet) {
  return `bus:v1:${packet.packet_type}:${sha256(stableJson(packetIdentityInput(packet)))}`;
}

export function sealPacket(draft) {
  const packet = structuredClone(draft);
  packet.provenance = { ...packet.provenance, content_sha256: sha256(stableJson(packet.body)) };
  packet.packet_id = expectedPacketId(packet);
  return packet;
}

export function validatePacket(packet, { now = new Date() } = {}) {
  plainObject(packet, "invalid_packet");
  if (Buffer.byteLength(JSON.stringify(packet), "utf8") > MAX_PACKET_BYTES) fail("packet_too_large");
  exactKeys(packet, [
    "schema_version", "packet_type", "packet_id", "sensitivity", "created_at", "expires_at",
    "provenance", "target_modules", "capability", "evidence_status", "confidence", "lineage",
    "observations", "body",
  ], "invalid_packet_keys");
  if (packet.schema_version !== SCHEMA_VERSION) fail("unsupported_packet_schema_version");
  if (!["knowledge", "skill"].includes(packet.packet_type)) fail("invalid_packet_type");
  if (packet.sensitivity !== "public") fail("public_bus_requires_public_sensitivity");
  boundedString(packet.packet_id, "packet_id", 96, {
    pattern: /^bus:v1:(knowledge|skill):[a-f0-9]{64}$/,
  });
  if (!packet.packet_id.startsWith(`bus:v1:${packet.packet_type}:`)) fail("packet_id_type_mismatch");
  boundedString(packet.capability, "capability", 128, { pattern: ID_RE });
  requireSortedUnique(packet.target_modules, "target_modules", { min: 1, max: 16 });
  if (!["verified", "candidate"].includes(packet.evidence_status)) fail("invalid_evidence_status");
  if (typeof packet.confidence !== "number" || !Number.isFinite(packet.confidence) || packet.confidence < 0 || packet.confidence > 1) {
    fail("invalid_confidence");
  }

  const createdAt = parseTimestamp(packet.created_at, "created_at");
  const expiresAt = parseTimestamp(packet.expires_at, "expires_at");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) fail("invalid_validation_time");
  if (createdAt > nowMs + MAX_FUTURE_SKEW_MS) fail("packet_created_in_future");
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_TTL_MS) fail("invalid_packet_ttl");
  if (expiresAt <= nowMs) fail("packet_expired");

  validateProvenance(packet.provenance);
  validateLineage(packet.lineage, packet.packet_id);
  validateObservations(packet.observations, createdAt, expiresAt);
  if (packet.packet_type === "knowledge") validateKnowledgeBody(packet.body);
  else validateSkillBody(packet.body);

  const actualContentSha = sha256(stableJson(packet.body));
  if (packet.provenance.content_sha256 !== actualContentSha) fail("content_sha256_mismatch");
  if (packet.packet_id !== expectedPacketId(packet)) fail("packet_identity_mismatch");
  return packet;
}

function gapSignal(type, details = {}) {
  const identity = { type, ...details };
  return {
    gap_id: `gap:v1:${sha256(stableJson(identity)).slice(0, 24)}`,
    ...identity,
  };
}

export function deriveGapSignals(packet, { now = new Date() } = {}) {
  validatePacket(packet, { now });
  const signals = [];
  if (packet.evidence_status !== "verified") {
    signals.push(gapSignal("evidence_unverified", { capability_id: packet.capability }));
  }
  if (packet.confidence < 0.8) {
    signals.push(gapSignal("low_confidence", { capability_id: packet.capability }));
  }
  if (Date.parse(packet.expires_at) - new Date(now).getTime() <= EXPIRING_SOON_MS) {
    signals.push(gapSignal("source_expiring", { capability_id: packet.capability }));
  }
  for (const observation of packet.observations) {
    if (observation.status === "ok") continue;
    signals.push(gapSignal(observation.status, {
      module_id: observation.module_id,
      capability_id: observation.capability_id,
      evidence_sha256: observation.evidence_sha256,
    }));
  }
  return signals.sort((left, right) => left.gap_id.localeCompare(right.gap_id));
}

export function inspectPacket(packet, { now = new Date(), seenPacketIds = [] } = {}) {
  validatePacket(packet, { now });
  const seen = new Set(seenPacketIds);
  if (seen.has(packet.packet_id)) {
    return {
      accepted: false,
      state: "DUPLICATE_REJECTED",
      packet_id: packet.packet_id,
      packet_type: packet.packet_type,
      capability: packet.capability,
      content_sha256: packet.provenance.content_sha256,
      gap_signals: [],
    };
  }
  return {
    accepted: true,
    state: "ACCEPTED",
    packet_id: packet.packet_id,
    packet_type: packet.packet_type,
    capability: packet.capability,
    content_sha256: packet.provenance.content_sha256,
    gap_signals: deriveGapSignals(packet, { now }),
  };
}

export { MAX_PACKET_BYTES, SCHEMA_VERSION };
