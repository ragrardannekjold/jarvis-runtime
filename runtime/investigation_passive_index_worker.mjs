#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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

    const started = initialReceipt(task, sha256(taskFile.raw), isoNow(now));
    const startedSha = await writePrivateJson(fetchImpl, token, receiptPath, started, {
      message: `investigation passive index task started ${task.task_id}`,
    });
    const result = task.capability === HISTORY_CAPABILITY
      ? await executePassiveHistoryTask(task, { ...historySource, env, fetchImpl, now })
      : await executePassiveIndexTask(task, { env, fetchImpl, now });
    const completed = {
      ...started,
      status: result.status,
      completed_at: isoNow(now),
      result,
    };
    const completedSha = await writePrivateJson(fetchImpl, token, receiptPath, completed, {
      sha: startedSha,
      message: `investigation passive index task completed ${task.task_id}`,
    });
    const completedHash = sha256(Buffer.from(`${JSON.stringify(completed, null, 2)}\n`, "utf8"));
    return publicStatus(result.status, {
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
