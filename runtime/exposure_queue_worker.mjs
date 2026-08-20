#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseAsset } from "./exposure-intelligence/src/assets.mjs";
import { createExposureEngine } from "./exposure-intelligence/src/engine.mjs";
import { readEvidence } from "./exposure-intelligence/src/evidence.mjs";

const PRIVATE_REPO = "ragrardannekjold/jarvis-command-center";
const STATE_BRANCH = "jarvis-runtime-state";
const PENDING_DIRECTORY = "runtime/exposure/queue/pending";
const RESULT_DIRECTORY = "runtime/exposure/results";
const MAX_TASK_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const DOCUMENTATION_ASSETS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "192.0.2.0/24",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "2001:db8::/32",
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

function encodeContentPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : "UNEXPECTED_ERROR";
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
        "user-agent": "jarvis-exposure-runtime/1.0",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new WorkerError("PRIVATE_STATE_TRANSPORT_ERROR", "Private runtime state was unavailable.", { cause });
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
    throw new WorkerError("PRIVATE_QUEUE_READ_FAILED", "Private task queue could not be read.", { status: result.status });
  }
  return result.document
    .filter((entry) => entry?.type === "file" && typeof entry.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,80}\.json$/.test(entry.name))
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
    throw new WorkerError("PRIVATE_FILE_READ_FAILED", "Private task data could not be read.", { status: result.status });
  }
  const { content, encoding, sha } = result.document;
  if (encoding !== "base64" || typeof content !== "string" || typeof sha !== "string") {
    throw new WorkerError("PRIVATE_FILE_RESPONSE_INVALID", "Private task data had an unsupported representation.");
  }
  const raw = Buffer.from(content.replaceAll("\n", ""), "base64");
  if (raw.byteLength > maxBytes) {
    throw new WorkerError("PRIVATE_FILE_TOO_LARGE", "Private runtime file exceeded the size limit.");
  }
  return { raw, sha };
}

async function readPrivateJson(fetchImpl, token, privatePath, options = {}) {
  const file = await readPrivateFile(fetchImpl, token, privatePath, options);
  if (file === null) return null;
  let document;
  try {
    document = JSON.parse(file.raw.toString("utf8"));
  } catch {
    throw new WorkerError("PRIVATE_TASK_JSON_INVALID", "Private task was not valid JSON.");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new WorkerError("PRIVATE_TASK_SCHEMA_INVALID", "Private task root must be an object.");
  }
  return { ...file, document };
}

async function writePrivateJson(fetchImpl, token, privatePath, document, { sha = undefined, message }) {
  const raw = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (raw.byteLength > MAX_RECEIPT_BYTES) {
    throw new WorkerError("PRIVATE_RECEIPT_TOO_LARGE", "Private result receipt exceeded the size limit.");
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
    throw new WorkerError("PRIVATE_RECEIPT_WRITE_FAILED", "Private result receipt could not be persisted.", { status: result.status });
  }
  return result.document.content.sha;
}

function assertExactKeys(document, allowed, code) {
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) throw new WorkerError(code, "Private task contained an unsupported field.");
  }
}

function parseTimestamp(value, fieldName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new WorkerError("PRIVATE_TASK_TIME_INVALID", `${fieldName} must be an ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new WorkerError("PRIVATE_TASK_TIME_INVALID", `${fieldName} must be an ISO timestamp.`);
  return parsed;
}

export function validateTask(document, filename, { now = Date.now } = {}) {
  assertExactKeys(document, new Set([
    "schema_version", "task_id", "project_id", "capability", "mode", "asset", "provider",
    "page_size", "max_pages", "max_query_credits", "created_at", "expires_at", "authorization",
  ]), "PRIVATE_TASK_SCHEMA_INVALID");
  if (document.schema_version !== 1) throw new WorkerError("PRIVATE_TASK_SCHEMA_INVALID", "Unsupported task schema.");
  if (typeof document.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,80}$/.test(document.task_id)) {
    throw new WorkerError("PRIVATE_TASK_ID_INVALID", "Task identifier was invalid.");
  }
  if (filename !== `${document.task_id}.json`) throw new WorkerError("PRIVATE_TASK_ID_MISMATCH", "Task filename did not match its identifier.");
  if (typeof document.project_id !== "string" || !/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(document.project_id)) {
    throw new WorkerError("PRIVATE_PROJECT_ID_INVALID", "Project identifier was invalid.");
  }
  if (document.capability !== "exposure.lookup" || document.mode !== "passive") {
    throw new WorkerError("PRIVATE_TASK_CAPABILITY_INVALID", "Only passive exposure.lookup tasks are accepted.");
  }
  if (document.provider !== "auto") throw new WorkerError("PRIVATE_TASK_PROVIDER_INVALID", "Provider routing must remain automatic.");
  if (!Number.isInteger(document.page_size) || document.page_size < 1 || document.page_size > 100) {
    throw new WorkerError("PRIVATE_TASK_PAGE_SIZE_INVALID", "Page size must be between 1 and 100.");
  }
  if (document.max_pages !== 1 || document.max_query_credits !== 1) {
    throw new WorkerError("PRIVATE_TASK_BUDGET_INVALID", "A task is limited to one page and at most one Shodan query credit.");
  }
  const asset = parseAsset(document.asset);
  const createdAt = parseTimestamp(document.created_at, "created_at");
  const expiresAt = parseTimestamp(document.expires_at, "expires_at");
  const current = now();
  if (createdAt > current + 5 * 60_000 || expiresAt <= current || expiresAt - createdAt > 7 * 24 * 60 * 60_000) {
    throw new WorkerError("PRIVATE_TASK_EXPIRED", "Task authorization window was invalid or expired.");
  }
  const authorization = document.authorization;
  if (typeof authorization !== "object" || authorization === null || Array.isArray(authorization)) {
    throw new WorkerError("PRIVATE_TASK_AUTHORIZATION_INVALID", "Task authorization was missing.");
  }
  assertExactKeys(authorization, new Set([
    "basis", "approved_by", "approved_at", "scope", "active_scanning",
  ]), "PRIVATE_TASK_AUTHORIZATION_INVALID");
  if (!["DOCUMENTATION_RESERVED", "OWNED_OR_EXPLICITLY_AUTHORIZED"].includes(authorization.basis)
    || authorization.approved_by !== "owner"
    || authorization.scope !== "passive_internet_exposure"
    || authorization.active_scanning !== false) {
    throw new WorkerError("PRIVATE_TASK_AUTHORIZATION_INVALID", "Task authorization did not satisfy the passive-read contract.");
  }
  const approvedAt = parseTimestamp(authorization.approved_at, "authorization.approved_at");
  if (approvedAt > current + 5 * 60_000 || approvedAt > createdAt + 5 * 60_000) {
    throw new WorkerError("PRIVATE_TASK_AUTHORIZATION_INVALID", "Task authorization timestamp was invalid.");
  }
  if (authorization.basis === "DOCUMENTATION_RESERVED" && !DOCUMENTATION_ASSETS.has(asset.value)) {
    throw new WorkerError("PRIVATE_TASK_AUTHORIZATION_INVALID", "Documentation authorization may only use reserved example assets.");
  }
  return { ...document, asset: asset.value, asset_type: asset.type };
}

function receiptEvents(ledger) {
  return ledger.entries.map((entry) => ({
    seq: entry.seq,
    recorded_at: entry.recordedAt,
    kind: entry.kind,
    hash: entry.hash,
    payload: entry.payload,
  }));
}

function shodanCreditsSpent(ledger) {
  return ledger.entries
    .filter((entry) => entry.kind === "provider_page" && entry.payload?.provider === "shodan")
    .reduce((total, entry) => total + (Number.isSafeInteger(entry.payload?.meta?.queryCreditsSpent) ? entry.payload.meta.queryCreditsSpent : 0), 0);
}

async function executeTask(task, { env, fetchImpl, now }) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "jarvis-exposure-"));
  const allowlistPath = path.join(baseDir, "allowlist.json");
  await writeFile(allowlistPath, `${JSON.stringify({
    schemaVersion: 1,
    authorization: "owned_or_explicitly_authorized",
    assets: [{ type: task.asset_type, value: task.asset }],
  })}\n`, { mode: 0o600 });
  const engine = createExposureEngine({ baseDir, env, fetchImpl, now });
  let result = null;
  let failure = null;
  try {
    result = await engine.collect({
      asset: task.asset,
      allowlistPath,
      execute: true,
      provider: "auto",
      pageSize: task.page_size,
      maxPages: 1,
    });
  } catch (error) {
    failure = error;
  }
  const evidencePath = path.join(baseDir, "evidence", "exposure.ndjson");
  const ledger = await readEvidence(evidencePath);
  const creditsSpent = shodanCreditsSpent(ledger);
  if (creditsSpent > task.max_query_credits) {
    throw new WorkerError("QUERY_CREDIT_BUDGET_EXCEEDED", "Provider execution exceeded its approved credit budget.");
  }
  return { result, failure, ledger, creditsSpent };
}

function initialReceipt(task, requestHash, startedAt) {
  return {
    schema_version: 1,
    private_only: true,
    task_id: task.task_id,
    project_id: task.project_id,
    capability: task.capability,
    status: "STARTED_FAIL_CLOSED",
    request_sha256: requestHash,
    started_at: startedAt,
    target: { type: task.asset_type, value: task.asset },
    authorization: task.authorization,
    execution_contract: {
      passive_only: true,
      active_scanning: false,
      provider_route: ["shodan", "censys", "netlas"],
      max_pages: 1,
      max_shodan_query_credits: 1,
      automatic_retry_after_ambiguous_outcome: false,
    },
  };
}

function finalReceipt(initial, execution, completedAt) {
  const observations = execution.ledger.entries
    .filter((entry) => entry.kind === "observation")
    .map((entry) => entry.payload);
  const errorCode = execution.failure ? safeErrorCode(execution.failure) : null;
  return {
    ...initial,
    status: execution.failure
      ? (execution.failure.ambiguous ? "AMBIGUOUS_REVIEW_REQUIRED" : "FAILED")
      : (execution.result?.status === "COMPLETE" ? "COMPLETE" : "PAGE_LIMIT_REACHED"),
    completed_at: completedAt,
    provider: execution.result?.provider ?? null,
    provider_status: execution.result?.status ?? null,
    error_code: errorCode,
    ambiguous: Boolean(execution.failure?.ambiguous),
    query_credits_spent: execution.failure?.ambiguous ? "UNKNOWN_0_OR_1" : execution.creditsSpent,
    observations_written: observations.length,
    observations,
    evidence: {
      valid: execution.ledger.valid,
      entry_count: execution.ledger.count,
      head_sha256: execution.ledger.headHash,
      events: receiptEvents(execution.ledger),
    },
  };
}

function publicStatus(status, extra = {}) {
  return {
    capability: "exposure.lookup",
    status,
    private_target_logged: false,
    private_result_logged: false,
    ...extra,
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
      task = validateTask(taskFile.document, queueEntry.name, { now });
    } catch (error) {
      const rejectionPath = `${RESULT_DIRECTORY}/${fallbackTaskId}.json`;
      const existingRejection = await readPrivateJson(fetchImpl, token, rejectionPath, { maxBytes: MAX_RECEIPT_BYTES });
      if (existingRejection !== null) continue;
      const rejected = {
        schema_version: 1,
        private_only: true,
        task_id: fallbackTaskId,
        capability: "exposure.lookup",
        status: "REJECTED",
        error_code: safeErrorCode(error),
        request_sha256: sha256(taskFile.raw),
        rejected_at: isoNow(now),
        provider_request_sent: false,
      };
      await writePrivateJson(fetchImpl, token, rejectionPath, rejected, {
        message: `exposure task rejected ${fallbackTaskId}`,
      });
      return publicStatus("REJECTED", { error_code: rejected.error_code });
    }

    const requestHash = sha256(taskFile.raw);
    const receiptPath = `${RESULT_DIRECTORY}/${task.task_id}.json`;
    const existing = await readPrivateJson(fetchImpl, token, receiptPath, { maxBytes: MAX_RECEIPT_BYTES });
    if (existing !== null) {
      if (existing.document.status === "STARTED_FAIL_CLOSED") {
        return publicStatus("REVIEW_REQUIRED", { receipt_sha256: sha256(existing.raw) });
      }
      continue;
    }

    const startedAt = isoNow(now);
    const started = initialReceipt(task, requestHash, startedAt);
    const startedSha = await writePrivateJson(fetchImpl, token, receiptPath, started, {
      message: `exposure task started ${task.task_id}`,
    });

    const execution = await executeTask(task, { env, fetchImpl, now });
    const completed = finalReceipt(started, execution, isoNow(now));
    const completedSha = await writePrivateJson(fetchImpl, token, receiptPath, completed, {
      sha: startedSha,
      message: `exposure task completed ${task.task_id}`,
    });
    const completedHash = sha256(Buffer.from(`${JSON.stringify(completed, null, 2)}\n`, "utf8"));
    return publicStatus(completed.status, {
      provider: completed.provider,
      query_credits_spent: completed.query_credits_spent,
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
    if (["FAILED", "AMBIGUOUS_REVIEW_REQUIRED", "REVIEW_REQUIRED"].includes(status.status)) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicStatus("WORKER_FAILED", { error_code: safeErrorCode(error) }))}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
