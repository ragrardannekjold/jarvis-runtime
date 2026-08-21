#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  executePassiveHistoryTask,
  executePassiveIndexTask,
  validatePassiveHistoryTask,
  validatePassiveIndexTask,
} from "./investigation_passive_index.mjs";

const CAPABILITY = "investigation.passive_index_search";
const HISTORY_CAPABILITY = "investigation.passive_index_history_recovery";
const PRIVATE_REPO = "ragrardannekjold/jarvis-command-center";
const STATE_BRANCH = "jarvis-runtime-state";
const PENDING_DIRECTORY = "runtime/investigation/queue/pending";
const RESULT_DIRECTORY = "runtime/investigation/results";
const MAX_TASK_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 512 * 1024;
const CAPRND_RUNTIME_RECEIPT_KEY_ENV = "JARVIS_CAPRND_RUNTIME_RECEIPT_HMAC_KEY_HEX";
const CAPRND_RECEIPT_TTL_MS = 60 * 60_000;
const CAPRND_RUNTIME_VALIDATOR = Object.freeze({
  path: "runtime/investigation_passive_index.mjs",
  git_blob_sha: "43196e1b81ae8d30a03df036795c1b288075c09e",
});
const CAPRND_ATTESTATION_DOMAIN = Object.freeze({
  schema_version: 1,
  algorithm: "HMAC-SHA256",
  issuer: "capability.private-runtime",
  key_id: "CAPRND_RUNTIME_RECEIPT_V1",
  purpose: "CAPABILITY_RND_RUNTIME_RECEIPT",
});
const CAPRND_RECEIPT_FIELDS = Object.freeze([
  "schema_version", "private_only", "capability", "task_id", "project_id", "status",
  "request_sha256", "started_at", "completed_at", "runtime_context_binding_sha256",
  "execution_contract", "result", "attestation",
]);
const CAPRND_RESULT_FIELDS = Object.freeze([
  "schema_version", "private_only", "capability", "project_id", "task_id", "status",
  "error_code", "provider", "additional_monetary_spend_usd", "provider_requests_sent",
  "query_credits_spent", "query_credit_min", "query_credit_max", "collected_at",
  "observations", "quality_metrics", "parent_investigation_effect",
]);
const CAPRND_ATTESTATION_FIELDS = Object.freeze([
  "schema_version", "algorithm", "issuer", "key_id", "purpose", "issued_at",
  "expires_at", "nonce", "mac",
]);

class WorkerError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : "UNEXPECTED_ERROR";
}

function safeReceiptErrorCode(value) {
  return typeof value === "string" && /^[A-Z0-9_]{2,80}$/.test(value)
    ? value
    : "UNCLASSIFIED_PROVIDER_FAILURE";
}

function assertExactKeySet(document, expected, code) {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new WorkerError(code, "Attested document must be an object.");
  }
  const actual = Object.keys(document).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WorkerError(code, "Attested document fields did not match the exact schema.");
  }
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkerError("CAPRND_RECEIPT_CANONICALIZATION_FAILED", "Non-finite numbers are not accepted.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new WorkerError("CAPRND_RECEIPT_CANONICALIZATION_FAILED", "Unsupported JSON value was rejected.");
}

function parseIsoMillis(value, code) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new WorkerError(code, "Timestamp was not an ISO string.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new WorkerError(code, "Timestamp was invalid.");
  return parsed;
}

function readCapabilityRndReceiptKey(env) {
  const encoded = env?.[CAPRND_RUNTIME_RECEIPT_KEY_ENV];
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new WorkerError("CAPRND_RUNTIME_RECEIPT_KEY_MISSING", "Capability R&D receipt key is unavailable.");
  }
  if (!/^[0-9a-fA-F]{64,}$/.test(encoded) || encoded.length % 2 !== 0) {
    throw new WorkerError("CAPRND_RUNTIME_RECEIPT_KEY_INVALID", "Capability R&D receipt key is invalid.");
  }
  const key = Buffer.from(encoded, "hex");
  if (key.byteLength < 32) {
    throw new WorkerError("CAPRND_RUNTIME_RECEIPT_KEY_INVALID", "Capability R&D receipt key is too short.");
  }
  return key;
}

function capabilityRndMacInput(document) {
  const { attestation, ...payload } = document;
  const { mac: _mac, ...unsignedAttestation } = attestation;
  return Buffer.from(canonicalJson({ payload, attestation: unsignedAttestation }), "utf8");
}

export function signCapabilityRndReceipt(receipt, { env = process.env } = {}) {
  if (Object.hasOwn(receipt, "attestation")) {
    throw new WorkerError("CAPRND_RECEIPT_SCHEMA_INVALID", "Receipt must be unsigned before signing.");
  }
  const key = readCapabilityRndReceiptKey(env);
  const completedAt = receipt.completed_at;
  const completedMillis = parseIsoMillis(completedAt, "CAPRND_RECEIPT_TIME_INVALID");
  const attestation = {
    ...CAPRND_ATTESTATION_DOMAIN,
    issued_at: completedAt,
    expires_at: new Date(completedMillis + CAPRND_RECEIPT_TTL_MS).toISOString(),
    nonce: `caprnd-${sha256(`${receipt.task_id}|${completedAt}`).slice(0, 48)}`,
    mac: "",
  };
  const signed = { ...receipt, attestation };
  signed.attestation.mac = createHmac("sha256", key).update(capabilityRndMacInput(signed)).digest("hex");
  return signed;
}

export function verifyCapabilityRndReceipt(receipt, { env = process.env } = {}) {
  const key = readCapabilityRndReceiptKey(env);
  assertExactKeySet(receipt, CAPRND_RECEIPT_FIELDS, "CAPRND_RECEIPT_SCHEMA_INVALID");
  assertExactKeySet(receipt.result, CAPRND_RESULT_FIELDS, "CAPRND_RECEIPT_RESULT_SCHEMA_INVALID");
  assertExactKeySet(receipt.attestation, CAPRND_ATTESTATION_FIELDS, "CAPRND_RECEIPT_ATTESTATION_INVALID");
  assertExactKeySet(
    receipt.execution_contract,
    ["active_scanning", "raw_provider_records_persisted", "public_target_output", "runtime_validator"],
    "CAPRND_RECEIPT_EXECUTION_CONTRACT_INVALID",
  );
  assertExactKeySet(
    receipt.execution_contract.runtime_validator,
    ["path", "git_blob_sha"],
    "CAPRND_RECEIPT_EXECUTION_CONTRACT_INVALID",
  );
  assertExactKeySet(
    receipt.result.quality_metrics,
    ["normalized_observations", "dropped_out_of_exact_scope", "active_scans", "raw_banners_persisted"],
    "CAPRND_RECEIPT_RESULT_SCHEMA_INVALID",
  );
  if (receipt.schema_version !== 2
    || receipt.private_only !== true
    || receipt.capability !== CAPABILITY
    || !["COMPLETE", "PARTIAL"].includes(receipt.status)
    || receipt.result.schema_version !== 2
    || receipt.result.private_only !== true
    || receipt.result.capability !== receipt.capability
    || receipt.result.project_id !== receipt.project_id
    || receipt.result.task_id !== receipt.task_id
    || receipt.result.status !== receipt.status
    || receipt.result.provider !== "shodan"
    || receipt.result.additional_monetary_spend_usd !== 0
    || receipt.execution_contract.active_scanning !== false
    || receipt.execution_contract.raw_provider_records_persisted !== false
    || receipt.execution_contract.public_target_output !== false
    || receipt.execution_contract.runtime_validator.path !== CAPRND_RUNTIME_VALIDATOR.path
    || receipt.execution_contract.runtime_validator.git_blob_sha !== CAPRND_RUNTIME_VALIDATOR.git_blob_sha
    || typeof receipt.runtime_context_binding_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(receipt.runtime_context_binding_sha256)) {
    throw new WorkerError("CAPRND_RECEIPT_SCHEMA_INVALID", "Receipt did not match the Capability R&D readback contract.");
  }
  if ((receipt.status === "COMPLETE" && receipt.result.error_code !== null)
    || (receipt.status === "PARTIAL" && safeReceiptErrorCode(receipt.result.error_code) !== receipt.result.error_code)
    || receipt.result.quality_metrics.normalized_observations !== receipt.result.observations.length
    || receipt.result.quality_metrics.active_scans !== 0
    || receipt.result.quality_metrics.raw_banners_persisted !== 0
    || containsRawBannerField(receipt.result.observations)) {
    throw new WorkerError("CAPRND_RECEIPT_RESULT_SCHEMA_INVALID", "Receipt result violated its passive readback contract.");
  }
  for (const [name, expected] of Object.entries(CAPRND_ATTESTATION_DOMAIN)) {
    if (receipt.attestation[name] !== expected) {
      throw new WorkerError("CAPRND_RECEIPT_ATTESTATION_INVALID", "Receipt attestation trust domain drifted.");
    }
  }
  const completedMillis = parseIsoMillis(receipt.completed_at, "CAPRND_RECEIPT_TIME_INVALID");
  const issuedMillis = parseIsoMillis(receipt.attestation.issued_at, "CAPRND_RECEIPT_TIME_INVALID");
  const expiresMillis = parseIsoMillis(receipt.attestation.expires_at, "CAPRND_RECEIPT_TIME_INVALID");
  if (issuedMillis !== completedMillis
    || expiresMillis <= issuedMillis
    || expiresMillis > issuedMillis + CAPRND_RECEIPT_TTL_MS) {
    throw new WorkerError("CAPRND_RECEIPT_ATTESTATION_INVALID", "Receipt attestation window was invalid.");
  }
  if (typeof receipt.attestation.nonce !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,80}$/.test(receipt.attestation.nonce)
    || typeof receipt.attestation.mac !== "string"
    || !/^[0-9a-f]{64}$/.test(receipt.attestation.mac)) {
    throw new WorkerError("CAPRND_RECEIPT_ATTESTATION_INVALID", "Receipt attestation metadata was invalid.");
  }
  const expected = createHmac("sha256", key).update(capabilityRndMacInput(receipt)).digest();
  const observed = Buffer.from(receipt.attestation.mac, "hex");
  if (observed.byteLength !== expected.byteLength || !timingSafeEqual(observed, expected)) {
    throw new WorkerError("CAPRND_RECEIPT_ATTESTATION_INVALID", "Receipt attestation verification failed.");
  }
  return receipt;
}

function encodeContentPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

async function githubRequest(fetchImpl, token, apiPath, { method = "GET", body = undefined } = {}) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${apiPath}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "jarvis-investigation-passive-index/1.0",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new WorkerError("PRIVATE_STATE_TRANSPORT_ERROR", "Private runtime state was unavailable.");
  }
  let document = null;
  const text = await response.text();
  if (text) {
    try {
      document = JSON.parse(text);
    } catch {
      throw new WorkerError("PRIVATE_STATE_RESPONSE_INVALID", "Private runtime state returned invalid JSON.", { status: response.status });
    }
  }
  return { status: response.status, document };
}

async function listPendingTasks(fetchImpl, token) {
  const encoded = encodeContentPath(PENDING_DIRECTORY);
  const result = await githubRequest(
    fetchImpl,
    token,
    `/repos/${PRIVATE_REPO}/contents/${encoded}?ref=${encodeURIComponent(STATE_BRANCH)}`,
  );
  if (result.status === 404) return [];
  if (result.status !== 200 || !Array.isArray(result.document)) {
    throw new WorkerError("PRIVATE_QUEUE_READ_FAILED", "Private Investigation queue could not be read.", { status: result.status });
  }
  return result.document
    .filter((entry) => entry?.type === "file"
      && typeof entry.name === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._-]{7,80}\.json$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readPrivateFile(fetchImpl, token, privatePath, { maxBytes = MAX_TASK_BYTES } = {}) {
  const encoded = encodeContentPath(privatePath);
  const result = await githubRequest(
    fetchImpl,
    token,
    `/repos/${PRIVATE_REPO}/contents/${encoded}?ref=${encodeURIComponent(STATE_BRANCH)}`,
  );
  if (result.status === 404) return null;
  if (result.status !== 200 || typeof result.document !== "object" || result.document === null) {
    throw new WorkerError("PRIVATE_FILE_READ_FAILED", "Private Investigation state could not be read.", { status: result.status });
  }
  const { content, encoding, sha } = result.document;
  if (encoding !== "base64" || typeof content !== "string" || typeof sha !== "string") {
    throw new WorkerError("PRIVATE_FILE_RESPONSE_INVALID", "Private Investigation state had an unsupported representation.");
  }
  const raw = Buffer.from(content.replaceAll("\n", ""), "base64");
  if (raw.byteLength > maxBytes) {
    throw new WorkerError("PRIVATE_FILE_TOO_LARGE", "Private Investigation state exceeded the size limit.");
  }
  return { raw, sha };
}

async function readPrivateJson(fetchImpl, token, privatePath, options = undefined) {
  const file = await readPrivateFile(fetchImpl, token, privatePath, options);
  if (file === null) return null;
  let document;
  try {
    document = JSON.parse(file.raw.toString("utf8"));
  } catch {
    throw new WorkerError("PRIVATE_FILE_JSON_INVALID", "Private Investigation state was not valid JSON.");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new WorkerError("PRIVATE_FILE_SCHEMA_INVALID", "Private Investigation state root must be an object.");
  }
  return { ...file, document };
}

async function writePrivateJson(fetchImpl, token, privatePath, document, { sha = undefined, message }) {
  const raw = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (raw.byteLength > MAX_RECEIPT_BYTES) {
    throw new WorkerError("PRIVATE_RECEIPT_TOO_LARGE", "Private Investigation receipt exceeded the size limit.");
  }
  const body = {
    message,
    content: raw.toString("base64"),
    branch: STATE_BRANCH,
  };
  if (sha) body.sha = sha;
  const encoded = encodeContentPath(privatePath);
  const result = await githubRequest(fetchImpl, token, `/repos/${PRIVATE_REPO}/contents/${encoded}`, {
    method: "PUT",
    body,
  });
  if (![200, 201].includes(result.status) || typeof result.document?.content?.sha !== "string") {
    throw new WorkerError("PRIVATE_RECEIPT_WRITE_FAILED", "Private Investigation receipt could not be persisted.", { status: result.status });
  }
  return result.document.content.sha;
}

function publicStatus(status, extra = {}) {
  return {
    capability: extra.capability ?? CAPABILITY,
    status,
    private_anchor_logged: false,
    private_result_logged: false,
    ...extra,
  };
}

function initialReceipt(task, requestHash, startedAt) {
  const isHistoryRecovery = task.capability === HISTORY_CAPABILITY;
  return {
    schema_version: task.schema_version,
    private_only: true,
    capability: task.capability,
    task_id: task.task_id,
    project_id: task.project_id,
    status: "STARTED_FAIL_CLOSED",
    request_sha256: requestHash,
    started_at: startedAt,
    source_task_ref_sha256: isHistoryRecovery ? sha256(task.source_task_id) : null,
    anchor_refs: (task.anchors ?? []).map((anchor) => ({
      anchor_id: anchor.anchor_id,
      entity_id: anchor.entity_id,
      source_publisher: anchor.source.publisher,
      source_ref_sha256: sha256(anchor.source.url),
    })),
    execution_contract: {
      passive_provider_index_only: true,
      active_scanning: false,
      allowed_endpoint_classes: isHistoryRecovery ? ["HOST_HISTORY"] : ["COUNT", "API_INFO", "SEARCH", "HOST_HISTORY"],
      arbitrary_query_allowed: false,
      max_provider_requests: task.max_provider_requests,
      max_query_credits: task.max_query_credits,
      raw_provider_records_persisted: false,
      public_target_output: false,
      private_normalized_observations: true,
      ambiguous_paid_request_auto_retry: false,
      search_allowed: !isHistoryRecovery,
    },
  };
}

function boundedNonnegativeInteger(value, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new WorkerError(code, "Receipt counter exceeded its authorized bound.");
  }
  return value;
}

function containsRawBannerField(value) {
  if (Array.isArray(value)) return value.some(containsRawBannerField);
  if (typeof value !== "object" || value === null) return false;
  const forbidden = new Set(["data", "banner", "raw_banner", "raw_provider_record", "provider_record"]);
  return Object.entries(value).some(([key, nested]) => forbidden.has(key.toLowerCase()) || containsRawBannerField(nested));
}

export function buildCapabilityRndReceipt(
  task,
  requestSha256,
  providerResult,
  startedAt,
  completedAt,
  { env = process.env } = {},
) {
  if (task.capability !== CAPABILITY
    || typeof task.runtime_context_binding_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(task.runtime_context_binding_sha256)) {
    throw new WorkerError("CAPRND_RECEIPT_TASK_BINDING_INVALID", "Capability R&D task binding was invalid.");
  }
  if (typeof requestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(requestSha256)) {
    throw new WorkerError("CAPRND_RECEIPT_TASK_HASH_INVALID", "Capability R&D task hash was invalid.");
  }
  const startedMillis = parseIsoMillis(startedAt, "CAPRND_RECEIPT_TIME_INVALID");
  const completedMillis = parseIsoMillis(completedAt, "CAPRND_RECEIPT_TIME_INVALID");
  if (startedMillis > completedMillis) {
    throw new WorkerError("CAPRND_RECEIPT_TIME_INVALID", "Receipt timestamps were incoherent.");
  }
  const status = providerResult.status === "COMPLETE" ? "COMPLETE" : "PARTIAL";
  if (status === "COMPLETE" && providerResult.error_code !== null) {
    throw new WorkerError("CAPRND_RECEIPT_STATUS_INVALID", "Complete provider result carried an error code.");
  }
  const observations = Array.isArray(providerResult.observations) ? providerResult.observations : [];
  if (containsRawBannerField(observations)) {
    throw new WorkerError("CAPRND_RAW_BANNER_REJECTED", "Raw provider banner fields cannot enter the receipt.");
  }
  const quality = typeof providerResult.quality_metrics === "object"
    && providerResult.quality_metrics !== null
    && !Array.isArray(providerResult.quality_metrics)
    ? providerResult.quality_metrics
    : {};
  const activeScans = boundedNonnegativeInteger(quality.active_scans ?? 0, 0, "CAPRND_ACTIVE_SCAN_REJECTED");
  const rawBanners = boundedNonnegativeInteger(quality.raw_banners_persisted ?? 0, 0, "CAPRND_RAW_BANNER_REJECTED");
  const providerRequests = boundedNonnegativeInteger(
    providerResult.provider_requests_sent ?? 0,
    task.max_provider_requests,
    "CAPRND_PROVIDER_REQUEST_LIMIT_EXCEEDED",
  );
  const queryMin = boundedNonnegativeInteger(
    providerResult.query_credit_min ?? 0,
    task.max_query_credits,
    "CAPRND_QUERY_CREDIT_LIMIT_EXCEEDED",
  );
  const queryMax = boundedNonnegativeInteger(
    providerResult.query_credit_max ?? 0,
    task.max_query_credits,
    "CAPRND_QUERY_CREDIT_LIMIT_EXCEEDED",
  );
  if (queryMin > queryMax) {
    throw new WorkerError("CAPRND_QUERY_CREDIT_LIMIT_EXCEEDED", "Query-credit bounds were incoherent.");
  }
  const querySpent = providerResult.query_credits_spent === null
    ? null
    : boundedNonnegativeInteger(
      providerResult.query_credits_spent ?? 0,
      task.max_query_credits,
      "CAPRND_QUERY_CREDIT_LIMIT_EXCEEDED",
    );
  if (querySpent !== null && (querySpent < queryMin || querySpent > queryMax)) {
    throw new WorkerError("CAPRND_QUERY_CREDIT_LIMIT_EXCEEDED", "Query-credit spend fell outside its bounds.");
  }
  if (providerResult.additional_monetary_spend_usd !== 0) {
    throw new WorkerError("CAPRND_UNEXPECTED_SPEND_REJECTED", "Capability R&D canary reported unapproved spend.");
  }
  const collectedAt = providerResult.collected_at ?? completedAt;
  const collectedMillis = parseIsoMillis(collectedAt, "CAPRND_RECEIPT_TIME_INVALID");
  if (collectedMillis < startedMillis || collectedMillis > completedMillis + 5 * 60_000) {
    throw new WorkerError("CAPRND_RECEIPT_TIME_INVALID", "Collection timestamp was incoherent.");
  }
  const result = {
    schema_version: 2,
    private_only: true,
    capability: task.capability,
    project_id: task.project_id,
    task_id: task.task_id,
    status,
    error_code: status === "COMPLETE" ? null : safeReceiptErrorCode(providerResult.error_code ?? "SHODAN_SENSOR_PARTIAL"),
    provider: "shodan",
    additional_monetary_spend_usd: 0,
    provider_requests_sent: providerRequests,
    query_credits_spent: querySpent,
    query_credit_min: queryMin,
    query_credit_max: queryMax,
    collected_at: collectedAt,
    observations,
    quality_metrics: {
      normalized_observations: observations.length,
      dropped_out_of_exact_scope: boundedNonnegativeInteger(
        quality.dropped_out_of_exact_scope ?? 0,
        Number.MAX_SAFE_INTEGER,
        "CAPRND_RECEIPT_QUALITY_INVALID",
      ),
      active_scans: activeScans,
      raw_banners_persisted: rawBanners,
    },
    parent_investigation_effect: status === "COMPLETE"
      ? "NONE_UNTIL_INDEPENDENT_CORROBORATION"
      : "NONE_SENSOR_PARTIAL",
  };
  const unsigned = {
    schema_version: 2,
    private_only: true,
    capability: task.capability,
    task_id: task.task_id,
    project_id: task.project_id,
    status,
    request_sha256: requestSha256,
    started_at: startedAt,
    completed_at: completedAt,
    runtime_context_binding_sha256: task.runtime_context_binding_sha256,
    execution_contract: {
      active_scanning: false,
      raw_provider_records_persisted: false,
      public_target_output: false,
      runtime_validator: CAPRND_RUNTIME_VALIDATOR,
    },
    result,
  };
  return verifyCapabilityRndReceipt(signCapabilityRndReceipt(unsigned, { env }), { env });
}

function validateQueuedTask(document, filename, { now }) {
  if (document?.capability === HISTORY_CAPABILITY) {
    return validatePassiveHistoryTask(document, filename, { now });
  }
  return validatePassiveIndexTask(document, filename, { now });
}

async function readHistorySource(fetchImpl, token, task, now) {
  const sourceTaskPath = `${PENDING_DIRECTORY}/${task.source_task_id}.json`;
  const sourceReceiptPath = `${RESULT_DIRECTORY}/${task.source_task_id}.json`;
  const sourceTaskFile = await readPrivateJson(fetchImpl, token, sourceTaskPath);
  if (sourceTaskFile === null) throw new WorkerError("PASSIVE_HISTORY_SOURCE_TASK_MISSING", "History recovery source task was unavailable.");
  const sourceTask = validatePassiveIndexTask(sourceTaskFile.document, `${task.source_task_id}.json`, { now, allowExpired: true });
  const sourceReceiptFile = await readPrivateJson(fetchImpl, token, sourceReceiptPath, { maxBytes: MAX_RECEIPT_BYTES });
  if (sourceReceiptFile === null) throw new WorkerError("PASSIVE_HISTORY_SOURCE_RECEIPT_MISSING", "History recovery source receipt was unavailable.");
  const sourceTaskSha256 = sha256(sourceTaskFile.raw);
  if (sourceReceiptFile.document.request_sha256 !== sourceTaskSha256) {
    throw new WorkerError("PASSIVE_HISTORY_SOURCE_RECEIPT_MISMATCH", "History recovery source receipt did not match the source task.");
  }
  return {
    sourceTask,
    sourceReceipt: sourceReceiptFile.document,
    sourceTaskSha256,
    sourceReceiptSha256: sha256(sourceReceiptFile.raw),
  };
}

export async function runOne({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const token = typeof env.COMMAND_CENTER_TOKEN === "string" ? env.COMMAND_CENTER_TOKEN.trim() : "";
  if (!token) throw new WorkerError("COMMAND_CENTER_TOKEN_MISSING", "Private bridge token is not configured.");
  const pending = await listPendingTasks(fetchImpl, token);
  if (pending.length === 0) return publicStatus("IDLE");

  for (const queueEntry of pending) {
    const taskFile = await readPrivateJson(fetchImpl, token, queueEntry.path);
    if (taskFile === null) continue;
    const fallbackTaskId = queueEntry.name.slice(0, -".json".length);
    let task;
    try {
      task = validateQueuedTask(taskFile.document, queueEntry.name, { now });
    } catch (error) {
      const rejectionPath = `${RESULT_DIRECTORY}/${fallbackTaskId}.json`;
      const existing = await readPrivateJson(fetchImpl, token, rejectionPath, { maxBytes: MAX_RECEIPT_BYTES });
      if (existing !== null) continue;
      const rejected = {
        schema_version: 2,
        private_only: true,
        capability: taskFile.document?.capability === HISTORY_CAPABILITY ? HISTORY_CAPABILITY : CAPABILITY,
        task_id: fallbackTaskId,
        status: "REJECTED",
        error_code: safeErrorCode(error),
        request_sha256: sha256(taskFile.raw),
        rejected_at: isoNow(now),
        provider_request_sent: false,
      };
      await writePrivateJson(fetchImpl, token, rejectionPath, rejected, {
        message: `investigation passive index task rejected ${fallbackTaskId}`,
      });
      return publicStatus("REJECTED", { capability: rejected.capability, error_code: rejected.error_code });
    }

    const receiptPath = `${RESULT_DIRECTORY}/${task.task_id}.json`;
    const existing = await readPrivateJson(fetchImpl, token, receiptPath, { maxBytes: MAX_RECEIPT_BYTES });
    if (existing !== null) {
      if (existing.document.status === "STARTED_FAIL_CLOSED") {
        return publicStatus("REVIEW_REQUIRED", { receipt_sha256: sha256(existing.raw) });
      }
      continue;
    }

    let historySource = null;
    if (task.capability === HISTORY_CAPABILITY) {
      try {
        historySource = await readHistorySource(fetchImpl, token, task, now);
      } catch (error) {
        const rejected = {
          schema_version: task.schema_version,
          private_only: true,
          capability: task.capability,
          task_id: task.task_id,
          project_id: task.project_id,
          status: "REJECTED",
          error_code: safeErrorCode(error),
          request_sha256: sha256(taskFile.raw),
          rejected_at: isoNow(now),
          provider_request_sent: false,
        };
        await writePrivateJson(fetchImpl, token, receiptPath, rejected, {
          message: `investigation passive history task rejected ${task.task_id}`,
        });
        return publicStatus("REJECTED", { capability: task.capability, error_code: rejected.error_code });
      }
    }

    if (task.capability === CAPABILITY) readCapabilityRndReceiptKey(env);

    const started = initialReceipt(task, sha256(taskFile.raw), isoNow(now));
    const startedSha = await writePrivateJson(fetchImpl, token, receiptPath, started, {
      message: `investigation passive index task started ${task.task_id}`,
    });
    const result = task.capability === HISTORY_CAPABILITY
      ? await executePassiveHistoryTask(task, { ...historySource, env, fetchImpl, now })
      : await executePassiveIndexTask(task, { env, fetchImpl, now });
    const completedAt = isoNow(now);
    const completed = task.capability === CAPABILITY
      ? buildCapabilityRndReceipt(
        task,
        sha256(taskFile.raw),
        result,
        started.started_at,
        completedAt,
        { env },
      )
      : {
        ...started,
        status: result.status,
        completed_at: completedAt,
        result,
      };
    const completedSha = await writePrivateJson(fetchImpl, token, receiptPath, completed, {
      sha: startedSha,
      message: `investigation passive index task completed ${task.task_id}`,
    });
    const completedHash = sha256(Buffer.from(`${JSON.stringify(completed, null, 2)}\n`, "utf8"));
    return publicStatus(completed.status, {
      capability: task.capability,
      provider: "shodan",
      completed_anchor_count: Array.isArray(result.anchors)
        ? result.anchors.filter((entry) => entry.status === "COMPLETE").length
        : 0,
      completed_history_request_count: Array.isArray(result.history_requests)
        ? result.history_requests.filter((entry) => entry.status === "COMPLETE").length
        : 0,
      normalized_observation_count: result.observations.length,
      query_credits_spent: result.query_credits_spent,
      query_credit_min: result.query_credit_min,
      query_credit_max: result.query_credit_max,
      query_credit_semantics: result.query_credit_semantics ?? "EXACT",
      receipt_sha256: completedHash,
      private_state_blob: completedSha.slice(0, 12),
    });
  }
  return publicStatus("IDLE");
}

async function main() {
  try {
    const status = await runOne();
    process.stdout.write(`${JSON.stringify(status)}\n`);
    if (status.status === "WORKER_FAILED") process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicStatus("WORKER_FAILED", { error_code: safeErrorCode(error) }))}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
