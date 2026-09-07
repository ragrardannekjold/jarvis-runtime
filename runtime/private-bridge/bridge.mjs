import { execFile } from "node:child_process";
import { createHash, createSign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BRIDGE_JOB_TYPE = "private_investigation_bridge_canary";
export const BRIDGE_BLOCKED = "BLOCKED_CREDENTIAL_PROVISIONING";
export const PRIVATE_REPOSITORY_OWNER = "ragrardannekjold";
export const PRIVATE_REPOSITORY_NAME = "jarvis-command-center";
export const PRIVATE_MAIN_REF = "main";
export const PRIVATE_STATE_REF = "jarvis-runtime-state";
export const PRIVATE_QUEUE_PREFIX = "runtime/investigation/queue/pending";
export const PRIVATE_RESULT_PREFIX = "runtime/investigation/results";
const PRIVATE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_PRIVATE_RECORD_BYTES = 128 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const APP_JWT_LIFETIME_SECONDS = 8 * 60;
const REQUIRED_ENV = [
  "JARVIS_PRIVATE_BRIDGE_APP_ID",
  "JARVIS_PRIVATE_BRIDGE_PRIVATE_KEY",
  "JARVIS_PRIVATE_BRIDGE_INSTALLATION_ID",
];

export class PrivateBridgeBlockedError extends Error {
  constructor(message = BRIDGE_BLOCKED) {
    super(message);
    this.name = "PrivateBridgeBlockedError";
    this.code = BRIDGE_BLOCKED;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return createHash("sha256").update(value).digest("hex");
  }
  const text = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function positiveIntegerString(value, field) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(text)) throw new PrivateBridgeBlockedError(`${BRIDGE_BLOCKED}:${field}`);
  return text;
}

export function loadBridgeCredentials(source = process.env) {
  const missing = REQUIRED_ENV.filter((name) => !String(source[name] ?? "").trim());
  if (missing.length) throw new PrivateBridgeBlockedError(`${BRIDGE_BLOCKED}:${missing.join(",")}`);
  const privateKey = String(source.JARVIS_PRIVATE_BRIDGE_PRIVATE_KEY).includes("\\n")
    ? String(source.JARVIS_PRIVATE_BRIDGE_PRIVATE_KEY).replaceAll("\\n", "\n")
    : String(source.JARVIS_PRIVATE_BRIDGE_PRIVATE_KEY);
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new PrivateBridgeBlockedError(`${BRIDGE_BLOCKED}:invalid_private_key`);
  }
  return {
    appId: positiveIntegerString(source.JARVIS_PRIVATE_BRIDGE_APP_ID, "app_id"),
    installationId: positiveIntegerString(source.JARVIS_PRIVATE_BRIDGE_INSTALLATION_ID, "installation_id"),
    privateKey,
  };
}

export function createGitHubAppJwt({ appId, privateKey, nowMs = Date.now() }) {
  const normalizedAppId = positiveIntegerString(appId, "app_id");
  if (!Number.isFinite(nowMs)) throw new Error("invalid_now_ms");
  const now = Math.floor(nowMs / 1000);
  const iat = now - 60;
  const exp = now + APP_JWT_LIFETIME_SECONDS;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat, exp, iss: normalizedAppId });
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function privateApiPath(relativePath) {
  return relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function checkedJson(response, code) {
  if (!response?.ok) throw new Error(`${code}_http_${response?.status ?? "unknown"}`);
  return response.json();
}

export async function mintInstallationToken({
  credentials,
  permission = "read",
  fetchImpl = fetch,
  nowMs = Date.now(),
}) {
  if (!new Set(["read", "write"]).has(permission)) throw new Error("invalid_contents_permission");
  const jwt = createGitHubAppJwt({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    nowMs,
  });
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${credentials.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis-runtime-private-bridge",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [PRIVATE_REPOSITORY_NAME],
        permissions: { contents: permission },
      }),
    },
  );
  const payload = await checkedJson(response, "installation_token");
  if (typeof payload.token !== "string" || payload.token.length < 20) {
    throw new Error("installation_token_missing");
  }
  const expiresAtMs = Date.parse(payload.expires_at || "");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + 60_000) {
    throw new Error("installation_token_expiry_invalid");
  }
  return { token: payload.token, expiresAt: payload.expires_at, permission };
}

async function privateRequest({ token, apiPath, method = "GET", body, fetchImpl = fetch, allow404 = false }) {
  const response = await fetchImpl(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-runtime-private-bridge",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (allow404 && response.status === 404) return null;
  return checkedJson(response, "private_repo");
}

function privateTaskId(value) {
  if (typeof value !== "string" || !PRIVATE_TASK_ID_RE.test(value) || value.includes("..")) {
    throw new Error("invalid_private_task_id");
  }
  return value;
}

function decodeJsonContentRecord(record, code) {
  if (!record || record.type !== "file" || typeof record.content !== "string" || record.encoding !== "base64") {
    throw new Error(`${code}_record_invalid`);
  }
  const bytes = Buffer.from(record.content.replaceAll("\n", ""), "base64");
  if (bytes.length < 2 || bytes.length > MAX_PRIVATE_RECORD_BYTES) {
    throw new Error(`${code}_record_size_invalid`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${code}_json_invalid`);
  }
}

export function validatePrivateCanaryTask(task, expectedTaskId, nowMs = Date.now()) {
  const taskId = privateTaskId(expectedTaskId);
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("invalid_private_task");
  if (task.schema_version !== 3) throw new Error("unsupported_private_task_schema");
  if (task.task_id !== taskId) throw new Error("private_task_identity_mismatch");
  if (task.capability !== "investigation.source_delta_external_runtime_canary") {
    throw new Error("private_capability_not_allowlisted");
  }
  if (task.mode !== "private_external_runtime_canary") throw new Error("private_mode_not_allowlisted");
  if (task.provider !== "controlled_https") throw new Error("private_provider_not_allowlisted");
  if (task.purpose !== "AI109_PRIVATE_BRIDGE_CANARY") throw new Error("private_purpose_not_allowlisted");
  const expiresAt = Date.parse(task.expires_at || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) throw new Error("private_task_expired");
  const authorization = task.authorization;
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
    throw new Error("private_authorization_missing");
  }
  if (authorization.active_scanning !== false) throw new Error("active_scanning_forbidden");
  if (authorization.public_targeting_output !== false) throw new Error("public_targeting_output_forbidden");
  if (authorization.private_normalized_observations !== true) {
    throw new Error("private_normalized_observations_required");
  }
  if (authorization.approved_by !== "owner") throw new Error("owner_authorization_required");
  return task;
}

export async function loadPrivatePendingTask({ token, taskId, fetchImpl = fetch, nowMs = Date.now() }) {
  const safeTaskId = privateTaskId(taskId);
  const relative = `${PRIVATE_QUEUE_PREFIX}/${safeTaskId}.json`;
  const record = await privateRequest({
    token,
    apiPath: `/repos/${PRIVATE_REPOSITORY_OWNER}/${PRIVATE_REPOSITORY_NAME}/contents/${privateApiPath(relative)}?ref=${encodeURIComponent(PRIVATE_STATE_REF)}`,
    fetchImpl,
    allow404: true,
  });
  if (!record) throw new Error("private_task_not_found");
  const task = decodeJsonContentRecord(record, "private_task");
  validatePrivateCanaryTask(task, safeTaskId, nowMs);
  return { task, sourceSha: record.sha, requestSha256: sha256(task) };
}

export function validatePrivateResultRecord(result, { taskId, capability, requestSha256 }) {
  const safeTaskId = privateTaskId(taskId);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid_private_result");
  if (result.schema_version !== 3 || result.private_only !== true) throw new Error("private_result_schema_invalid");
  if (result.task_id !== safeTaskId || result.capability !== capability) throw new Error("private_result_identity_mismatch");
  if (result.request_sha256 !== requestSha256 || !SHA256_RE.test(String(requestSha256 || ""))) {
    throw new Error("private_result_request_mismatch");
  }
  if (result.status !== "SUCCEEDED") throw new Error("private_result_not_succeeded");
  if (!SHA256_RE.test(String(result.result_sha256 || ""))) throw new Error("private_result_hash_invalid");
  const { result_sha256: recordedHash, ...material } = result;
  if (sha256(material) !== recordedHash) throw new Error("private_result_integrity_mismatch");
  const contract = result.execution_contract;
  if (!contract || contract.active_scanning !== false || contract.public_targeting_output !== false) {
    throw new Error("private_result_safety_contract_invalid");
  }
  if (contract.raw_private_stdout_persisted !== false || contract.raw_private_stderr_persisted !== false) {
    throw new Error("private_result_output_containment_invalid");
  }
  if (contract.child_received_github_token !== false || contract.child_received_app_private_key !== false) {
    throw new Error("private_result_credential_containment_invalid");
  }
  if (contract.gpt_required !== false) throw new Error("private_result_gpt_dependency_invalid");
  const detail = result.result;
  if (!detail || detail.terminal_readback_status !== "VERIFIED_DONE" || detail.terminal_readback_survived_restart !== true) {
    throw new Error("private_result_terminal_readback_invalid");
  }
  if (detail.event_count !== 1 || detail.task_count !== 1 || detail.mission_count !== 1) {
    throw new Error("private_result_cardinality_invalid");
  }
  if (detail.duplicate_submissions !== 1 || detail.no_change_collapsed !== 1 || detail.continuation_without_chat !== true) {
    throw new Error("private_result_restart_contract_invalid");
  }
  const parent = result.parent_investigation_effect;
  if (!parent || parent.fact_promotion !== false || parent.live_source_watcher_proven !== false) {
    throw new Error("private_result_parent_effect_invalid");
  }
  return result;
}

export async function loadPrivateExistingResult({ token, task, requestSha256, fetchImpl = fetch }) {
  const safeTaskId = privateTaskId(task.task_id);
  const relative = `${PRIVATE_RESULT_PREFIX}/${safeTaskId}.json`;
  const record = await privateRequest({
    token,
    apiPath: `/repos/${PRIVATE_REPOSITORY_OWNER}/${PRIVATE_REPOSITORY_NAME}/contents/${privateApiPath(relative)}?ref=${encodeURIComponent(PRIVATE_STATE_REF)}`,
    fetchImpl,
    allow404: true,
  });
  if (!record) return null;
  const result = decodeJsonContentRecord(record, "private_result");
  return validatePrivateResultRecord(result, {
    taskId: safeTaskId,
    capability: task.capability,
    requestSha256,
  });
}

export function isolatedChildEnv(source = process.env, extra = {}) {
  const env = {
    PATH: source.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG || "C.UTF-8",
    LC_ALL: source.LC_ALL || source.LANG || "C.UTF-8",
    ...extra,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("JARVIS_PRIVATE_BRIDGE_") || key === "GITHUB_TOKEN" || key === "GH_TOKEN") {
      delete env[key];
    }
  }
  return env;
}

export async function resolvePrivateMainCommit({ token, fetchImpl = fetch }) {
  const payload = await privateRequest({
    token,
    apiPath: `/repos/${PRIVATE_REPOSITORY_OWNER}/${PRIVATE_REPOSITORY_NAME}/commits/${encodeURIComponent(PRIVATE_MAIN_REF)}`,
    fetchImpl,
  });
  const commitSha = String(payload?.sha || "").toLowerCase();
  if (!GIT_SHA_RE.test(commitSha)) throw new Error("private_main_commit_invalid");
  return commitSha;
}

async function downloadPrivateArchive({ token, privateMainCommitSha, targetPath, fetchImpl = fetch }) {
  if (!GIT_SHA_RE.test(String(privateMainCommitSha || ""))) throw new Error("private_main_commit_invalid");
  const response = await fetchImpl(
    `https://api.github.com/repos/${PRIVATE_REPOSITORY_OWNER}/${PRIVATE_REPOSITORY_NAME}/tarball/${privateMainCommitSha}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis-runtime-private-bridge",
      },
    },
  );
  if (!response.ok) throw new Error(`private_archive_http_${response.status}`);
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error("private_archive_too_large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error("private_archive_size_invalid");
  await writeFile(targetPath, bytes, { mode: 0o600 });
  return sha256(bytes);
}

async function extractedRepositoryDir(extractRoot) {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) throw new Error("private_archive_layout_invalid");
  return path.join(extractRoot, directories[0].name);
}

function validateCanaryReceipt(receipt, phase) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("invalid_canary_receipt");
  const expectedPhase = phase === "first" ? "FIRST_PROCESS" : "RESTART_PROCESS";
  if (receipt.phase !== expectedPhase || receipt.status !== "PASS") throw new Error(`canary_${phase}_failed`);
  if (receipt.gpt_required !== false || receipt.chat_turn_required !== false || receipt.gpt_api_called !== false) {
    throw new Error("gpt_dependency_detected");
  }
  if (receipt.user_orchestration_touches !== 0 || receipt.main_manual_dispatches !== 0) {
    throw new Error("manual_orchestration_dependency_detected");
  }
  if (receipt.terminal_readback_status !== "VERIFIED_DONE") throw new Error("terminal_readback_missing");
  return receipt;
}

async function runPrivateCanary({ repositoryDir, tempRoot, execFileImpl = execFileAsync, envSource = process.env }) {
  const stateRoot = path.join(tempRoot, "state");
  const receiptsRoot = path.join(tempRoot, "receipts");
  const firstReceipt = path.join(receiptsRoot, "first.json");
  const restartReceipt = path.join(receiptsRoot, "restart.json");
  const pythonPath = path.join(repositoryDir, "src");
  const childEnv = isolatedChildEnv(envSource, { PYTHONPATH: pythonPath });
  const script = path.join(repositoryDir, "scripts", "source_delta_external_runtime_canary.py");
  const commonOptions = {
    cwd: repositoryDir,
    env: childEnv,
    timeout: 180000,
    maxBuffer: 512 * 1024,
  };
  await execFileImpl("mkdir", ["-p", stateRoot, receiptsRoot], { ...commonOptions, timeout: 30_000 });
  await execFileImpl("python3", [
    script,
    "--phase", "first",
    "--state-root", stateRoot,
    "--receipt", firstReceipt,
  ], commonOptions);
  await execFileImpl("python3", [
    script,
    "--phase", "restart",
    "--state-root", stateRoot,
    "--receipt", restartReceipt,
    "--previous-receipt", firstReceipt,
  ], commonOptions);
  const first = validateCanaryReceipt(JSON.parse(await readFile(firstReceipt, "utf8")), "first");
  const restart = validateCanaryReceipt(JSON.parse(await readFile(restartReceipt, "utf8")), "restart");
  if (first.event_count !== 1 || first.task_count !== 1 || first.mission_count !== 1) {
    throw new Error("first_process_cardinality_failed");
  }
  if (restart.event_count !== 1 || restart.task_count !== 1 || restart.mission_count !== 1) {
    throw new Error("restart_cardinality_failed");
  }
  if (restart.duplicate_submissions !== 1 || restart.no_change_collapsed !== 1) {
    throw new Error("restart_dedupe_failed");
  }
  if (restart.terminal_readback_survived_restart !== true || restart.continuation_without_chat !== true) {
    throw new Error("restart_continuity_failed");
  }
  return { first, restart };
}

export function privateResultRecord({
  task,
  requestSha256,
  privateTaskSourceSha,
  privateMainCommitSha,
  archiveSha256,
  first,
  restart,
  startedAt,
  completedAt,
}) {
  const result = {
    schema_version: 3,
    private_only: true,
    capability: task.capability,
    task_id: task.task_id,
    project_id: task.project_id,
    status: "SUCCEEDED",
    request_sha256: requestSha256,
    private_task_source_sha: privateTaskSourceSha,
    started_at: startedAt,
    completed_at: completedAt,
    execution_contract: {
      credential_model: "GITHUB_APP_SHORT_LIVED_INSTALLATION_TOKEN",
      repository_allowlist: `${PRIVATE_REPOSITORY_OWNER}/${PRIVATE_REPOSITORY_NAME}`,
      private_main_ref: PRIVATE_MAIN_REF,
      private_main_commit_sha: privateMainCommitSha,
      private_state_ref: PRIVATE_STATE_REF,
      active_scanning: false,
      public_targeting_output: false,
      raw_private_stdout_persisted: false,
      raw_private_stderr_persisted: false,
      child_received_github_token: false,
      child_received_app_private_key: false,
      gpt_required: false,
    },
    result: {
      archive_sha256: archiveSha256,
      first_receipt_sha256: first.receipt_sha256,
      restart_receipt_sha256: restart.receipt_sha256,
      terminal_readback_status: restart.terminal_readback_status,
      terminal_readback_survived_restart: true,
      event_count: restart.event_count,
      task_count: restart.task_count,
      mission_count: restart.mission_count,
      duplicate_submissions: restart.duplicate_submissions,
      no_change_collapsed: restart.no_change_collapsed,
      continuation_without_chat: true,
      next_advanced: restart.next_advanced === true,
      gpt_required: false,
      chat_turn_required: false,
    },
    parent_investigation_effect: {
      state: "CONTROLLED_EXTERNAL_PRIVATE_BRIDGE_CANARY_PASS",
      fact_promotion: false,
      live_source_watcher_proven: false,
      note: "Credential and transport canary only; does not promote investigation claims.",
    },
  };
  return { ...result, result_sha256: sha256(result) };
}

async function persistPrivateResult({ token, task, requestSha256, result, fetchImpl = fetch }) {
  const safeTaskId = privateTaskId(task.task_id);
  const existing = await loadPrivateExistingResult({ token, task, requestSha256, fetchImpl });
  if (existing) {
    return {
      state: "EXISTING_VERIFIED",
      privateResult: existing,
      resultSha256: existing.result_sha256,
    };
  }
  const relative = `${PRIVATE_RESULT_PREFIX}/${safeTaskId}.json`;
  const apiPath = `/repos/${PRIVATE_REPOSITORY_OWNER}/${PRIVATE_REPOSITORY_NAME}/contents/${privateApiPath(relative)}`;
  const text = `${JSON.stringify(result, null, 2)}\n`;
  await privateRequest({
    token,
    apiPath,
    method: "PUT",
    fetchImpl,
    body: {
      message: "AI-109: persist private bridge canary receipt",
      content: Buffer.from(text, "utf8").toString("base64"),
      branch: PRIVATE_STATE_REF,
    },
  });
  return {
    state: "CREATED",
    privateResult: result,
    resultSha256: result.result_sha256,
    contentSha256: sha256(text),
  };
}

export function publicBridgeReceipt({ taskId, privateResult, persistence }) {
  const receipt = {
    schema_version: 1,
    state: "PRIVATE_BRIDGE_SUCCEEDED",
    task_id: privateTaskId(taskId),
    private_result_sha256: privateResult.result_sha256,
    persistence_state: persistence.state,
    terminal_readback_status: privateResult.result.terminal_readback_status,
    terminal_readback_survived_restart: privateResult.result.terminal_readback_survived_restart,
    event_count: privateResult.result.event_count,
    task_count: privateResult.result.task_count,
    mission_count: privateResult.result.mission_count,
    duplicate_submissions: privateResult.result.duplicate_submissions,
    no_change_collapsed: privateResult.result.no_change_collapsed,
    gpt_required: false,
    chat_turn_required: false,
    private_payload_exposed: false,
    private_stdout_exposed: false,
    private_stderr_exposed: false,
    credential_persisted: false,
    live_source_watcher_proven: false,
  };
  return { ...receipt, receipt_sha256: sha256(receipt) };
}

export function renderPublicBridgeReceipt(receipt) {
  const safe = publicBridgeReceipt({
    taskId: receipt.task_id,
    privateResult: {
      result_sha256: receipt.private_result_sha256,
      result: {
        terminal_readback_status: receipt.terminal_readback_status,
        terminal_readback_survived_restart: receipt.terminal_readback_survived_restart,
        event_count: receipt.event_count,
        task_count: receipt.task_count,
        mission_count: receipt.mission_count,
        duplicate_submissions: receipt.duplicate_submissions,
        no_change_collapsed: receipt.no_change_collapsed,
      },
    },
    persistence: { state: receipt.persistence_state },
  });
  return JSON.stringify(safe);
}

export async function runPrivateInvestigationBridge({
  job,
  envSource = process.env,
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  now = () => new Date(),
}) {
  if (job?.job_type !== BRIDGE_JOB_TYPE) throw new Error("invalid_bridge_job_type");
  const taskId = privateTaskId(job?.canonical?.mission_id);
  if (!job?.canonical?.route_id || !job?.canonical?.cell_id) throw new Error("bridge_canonical_ids_required");
  const credentials = loadBridgeCredentials(envSource);
  const startedAt = now().toISOString();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jarvis-private-bridge-"));
  try {
    const readAccess = await mintInstallationToken({ credentials, permission: "read", fetchImpl });
    const pending = await loadPrivatePendingTask({
      token: readAccess.token,
      taskId,
      fetchImpl,
      nowMs: now().getTime(),
    });
    const existing = await loadPrivateExistingResult({
      token: readAccess.token,
      task: pending.task,
      requestSha256: pending.requestSha256,
      fetchImpl,
    });
    if (existing) {
      return publicBridgeReceipt({
        taskId,
        privateResult: existing,
        persistence: { state: "EXISTING_VERIFIED" },
      });
    }
    const privateMainCommitSha = await resolvePrivateMainCommit({
      token: readAccess.token,
      fetchImpl,
    });
    const archivePath = path.join(tempRoot, "private-main.tar.gz");
    const extractRoot = path.join(tempRoot, "checkout");
    await execFileImpl("mkdir", ["-p", extractRoot], {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: isolatedChildEnv(envSource),
    });
    const archiveSha256 = await downloadPrivateArchive({
      token: readAccess.token,
      privateMainCommitSha,
      targetPath: archivePath,
      fetchImpl,
    });
    await execFileImpl("tar", ["-xzf", archivePath, "-C", extractRoot], {
      timeout: 60_000,
      maxBuffer: 128 * 1024,
      env: isolatedChildEnv(envSource),
    });
    const repositoryDir = await extractedRepositoryDir(extractRoot);
    const { first, restart } = await runPrivateCanary({
      repositoryDir,
      tempRoot,
      execFileImpl,
      envSource,
    });
    const completedAt = now().toISOString();
    const privateResult = privateResultRecord({
      task: pending.task,
      requestSha256: pending.requestSha256,
      privateTaskSourceSha: pending.sourceSha,
      privateMainCommitSha,
      archiveSha256,
      first,
      restart,
      startedAt,
      completedAt,
    });
    const writeAccess = await mintInstallationToken({ credentials, permission: "write", fetchImpl });
    const persistence = await persistPrivateResult({
      token: writeAccess.token,
      task: pending.task,
      requestSha256: pending.requestSha256,
      result: privateResult,
      fetchImpl,
    });
    return publicBridgeReceipt({
      taskId,
      privateResult: persistence.privateResult,
      persistence,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
