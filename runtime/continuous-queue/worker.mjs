import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_BLOCKED,
  BRIDGE_JOB_TYPE,
  renderPublicBridgeReceipt,
  runPrivateInvestigationBridge,
} from "../private-bridge/bridge.mjs";

const execFileAsync = promisify(execFile);
const QUEUE_PREFIX = "[QUEUE-JOB]";
const PLAN_PREFIX = "[QUEUE-PLAN]";
const INTERNAL_PRODUCER = "continuous_queue_refill_v2";
const STATUS_EPOCH = "continuous_queue_status_v2";
const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "REJECTED"]);
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PRIVATE_BRIDGE_MISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_JOB_TYPES = new Set([
  "heartbeat_probe",
  "async_contract_self_test",
  "runtime_syntax_self_test",
  "sustained_rhythm_verification",
  BRIDGE_JOB_TYPE,
]);
const CANONICAL_ID_RE = /^[A-Za-z0-9._:/#-]{1,128}$/;
const MAX_PAYLOAD_BYTES = 2048;
const MAX_JOBS_PER_RUN = 8;
const MAX_RUNTIME_MS = 8 * 60 * 1000;
const DEFAULT_QUEUE_DEPTH = 2;
const MAX_QUEUE_DEPTH = 4;
const MAX_PLAN_TASKS = 32;
const ISSUE_PAGE_SIZE = 100;
const MAX_ISSUE_HISTORY_PAGES = 100;
const RESERVATION_LEASE_MS = 15 * 60 * 1000;
const TOKENLESS_CHILD_ENV = Object.freeze({});
const CANONICAL_PAYLOAD_KEYS = ["cell_id", "mission_id", "route_id"];
const JOB_PAYLOAD_KEYS = new Map([
  ["heartbeat_probe", CANONICAL_PAYLOAD_KEYS],
  ["async_contract_self_test", CANONICAL_PAYLOAD_KEYS],
  ["runtime_syntax_self_test", CANONICAL_PAYLOAD_KEYS],
  ["sustained_rhythm_verification", [...CANONICAL_PAYLOAD_KEYS, "hold_ms", "probe"]],
  [BRIDGE_JOB_TYPE, CANONICAL_PAYLOAD_KEYS],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

let repository;
let repositoryOwner;
let token;
let runId;

function loadRuntimeEnvironment() {
  repository = env("GITHUB_REPOSITORY");
  repositoryOwner = env("REPOSITORY_OWNER");
  token = env("GITHUB_TOKEN");
  runId = env("GITHUB_RUN_ID");
}

async function githubRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-runtime-continuous-queue",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_api_${response.status}:${text.slice(0, 300)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function canonicalId(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CANONICAL_ID_RE.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function reservationTimestampMs(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_RE.test(value)) {
    throw new Error("invalid_reservation_timestamp");
  }
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== value) {
    throw new Error("invalid_reservation_timestamp");
  }
  return timestampMs;
}

function assertExactKeys(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid_${label}`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}_fields_not_allowlisted`);
  }
}

function assertAllowedKeys(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid_${label}`);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label}_fields_not_allowlisted`);
  }
}

export function validateTaskSpec(task, { requireCanonical = false } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("invalid_task");
  assertExactKeys(task, ["job_type", "payload"], "task");
  if (!ALLOWED_JOB_TYPES.has(task.job_type)) throw new Error("job_type_not_allowlisted");
  const payload = task.payload;
  assertAllowedKeys(payload, JOB_PAYLOAD_KEYS.get(task.job_type), "payload");
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("payload_too_large");
  }
  const canonical = {
    mission_id: canonicalId(payload.mission_id, "mission_id"),
    route_id: canonicalId(payload.route_id, "route_id"),
    cell_id: canonicalId(payload.cell_id, "cell_id"),
  };
  const supplied = Object.values(canonical).filter(Boolean).length;
  if (supplied !== 0 && supplied !== 3) throw new Error("canonical_ids_must_be_complete");
  if (requireCanonical && supplied !== 3) throw new Error("plan_tasks_require_canonical_ids");
  if (task.job_type === BRIDGE_JOB_TYPE) {
    if (supplied !== 3) throw new Error("private_bridge_requires_canonical_ids");
    if (!PRIVATE_BRIDGE_MISSION_ID_RE.test(canonical.mission_id) || canonical.mission_id.includes("..")) {
      throw new Error("invalid_private_bridge_mission_id");
    }
  }
  if (task.job_type === "sustained_rhythm_verification") {
    if (!["runtime_syntax", "async_contract"].includes(payload.probe)) {
      throw new Error("invalid_sustained_rhythm_probe");
    }
    if (!Number.isInteger(payload.hold_ms) || payload.hold_ms < 90000 || payload.hold_ms > 120000) {
      throw new Error("invalid_sustained_rhythm_hold_ms");
    }
  }
  return { job_type: task.job_type, payload, canonical };
}

export function parseQueueJob(issue, authorizedOwner = repositoryOwner) {
  if (!issue?.number || issue.pull_request) throw new Error("not_queue_issue");
  if (!issue.title?.startsWith(QUEUE_PREFIX)) throw new Error("not_queue_title");

  let job;
  try {
    job = JSON.parse(issue.body || "{}");
  } catch {
    throw new Error("invalid_json");
  }

  const ownerAuthorized = issue.user?.login === authorizedOwner;
  const internalAuthorized = issue.user?.login === "github-actions[bot]" && job.producer === INTERNAL_PRODUCER;
  if (!ownerAuthorized && !internalAuthorized) throw new Error("queue_producer_not_authorized");

  if (ownerAuthorized) {
    assertExactKeys(
      job,
      ["schema_version", "job_type", "sensitivity", "payload"],
      "queue_job",
    );
  } else {
    assertExactKeys(
      job,
      ["schema_version", "producer", "job_type", "sensitivity", "payload"],
      "queue_job",
    );
    if (job.producer !== INTERNAL_PRODUCER) throw new Error("queue_producer_not_authorized");
  }

  if (job.schema_version !== 1) throw new Error("unsupported_schema_version");
  if (job.sensitivity !== "public") throw new Error("public_queue_requires_public_sensitivity");
  if (job.payload_ref !== undefined) throw new Error("private_payload_ref_not_enabled");

  const spec = validateTaskSpec({ job_type: job.job_type, payload: job.payload });
  return {
    issueNumber: issue.number,
    ...spec,
  };
}

export function parsePlanIssue(issue, authorizedOwner = repositoryOwner) {
  if (!issue?.number || issue.pull_request) throw new Error("not_plan_issue");
  if (!issue.title?.startsWith(PLAN_PREFIX)) throw new Error("not_plan_title");
  if (issue.user?.login !== authorizedOwner) throw new Error("plan_owner_mismatch");

  let plan;
  try {
    plan = JSON.parse(issue.body || "{}");
  } catch {
    throw new Error("invalid_plan_json");
  }
  assertAllowedKeys(
    plan,
    ["schema_version", "sensitivity", "plan_id", "target_queue_depth", "tasks", "dispatch_state"],
    "plan",
  );
  if (plan.schema_version !== 1) throw new Error("unsupported_plan_schema_version");
  if (plan.sensitivity !== "public") throw new Error("public_plan_requires_public_sensitivity");
  const planId = canonicalId(plan.plan_id, "plan_id");
  if (!planId) throw new Error("missing_plan_id");
  const targetQueueDepth = plan.target_queue_depth ?? DEFAULT_QUEUE_DEPTH;
  if (!Number.isInteger(targetQueueDepth) || targetQueueDepth < 1 || targetQueueDepth > MAX_QUEUE_DEPTH) {
    throw new Error("invalid_target_queue_depth");
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > MAX_PLAN_TASKS) {
    throw new Error("invalid_plan_tasks");
  }
  const tasks = plan.tasks.map((task) => validateTaskSpec(task, { requireCanonical: true }));
  const keys = tasks.map(taskKey);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate_task_identity_in_plan");

  const dispatchState = plan.dispatch_state ?? { schema_version: 1, issued: {} };
  if (!dispatchState || typeof dispatchState !== "object" || Array.isArray(dispatchState)) {
    throw new Error("invalid_dispatch_state");
  }
  assertExactKeys(dispatchState, ["schema_version", "issued"], "dispatch_state");
  if (dispatchState.schema_version !== 1) throw new Error("unsupported_dispatch_state_schema_version");
  if (!dispatchState.issued || typeof dispatchState.issued !== "object" || Array.isArray(dispatchState.issued)) {
    throw new Error("invalid_dispatch_issued_map");
  }
  const issued = new Map();
  for (const [key, record] of Object.entries(dispatchState.issued)) {
    if (!keys.includes(key)) throw new Error("dispatch_issued_key_not_in_plan");
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid_dispatch_record");
    assertExactKeys(record, ["issue_number", "reserved_at_utc"], "dispatch_record");
    const issueNumber = record.issue_number ?? null;
    if (issueNumber !== null && (!Number.isInteger(issueNumber) || issueNumber < 1)) {
      throw new Error("invalid_dispatch_issue_number");
    }
    reservationTimestampMs(record.reserved_at_utc);
    issued.set(key, {
      issue_number: issueNumber,
      reserved_at_utc: record.reserved_at_utc,
    });
  }
  return {
    issueNumber: issue.number,
    plan_id: planId,
    target_queue_depth: targetQueueDepth,
    tasks,
    raw_plan: plan,
    issued,
  };
}

export function taskKey(task) {
  const identity = [
    task.job_type,
    task.canonical?.mission_id || "",
    task.canonical?.route_id || "",
    task.canonical?.cell_id || "",
  ];
  if (task.job_type === "sustained_rhythm_verification") {
    identity.push(task.payload?.probe || "", String(task.payload?.hold_ms ?? ""));
  }
  return identity.join("|");
}

function queueTaskKeyFromIssue(issue, authorizedOwner = repositoryOwner) {
  try {
    return taskKey(parseQueueJob(issue, authorizedOwner));
  } catch {
    return null;
  }
}

function renderStatus(job, state, step, detail = null) {
  const lines = [
    "<!-- jarvis-queue-status -->",
    "**CONTINUOUS QUEUE STATUS**",
    `- status_epoch: ${STATUS_EPOCH}`,
    `- queue_job_id: \`${repository}#${job.issueNumber}/run-${runId}\``,
    job.canonical.mission_id ? `- mission_id: \`${job.canonical.mission_id}\`` : null,
    job.canonical.route_id ? `- route_id: \`${job.canonical.route_id}\`` : null,
    job.canonical.cell_id ? `- cell_id: \`${job.canonical.cell_id}\`` : null,
    `- job_type: \`${job.job_type}\``,
    `- task_identity: \`${taskKey(job)}\``,
    `- state: **${state}**`,
    `- step: ${step}`,
    `- heartbeat_utc: ${new Date().toISOString()}`,
    `- execution_surface: github_actions_continuous_queue`,
    `- chat_blocking: false`,
    `- policy_target: foreground <= 40% / reserve >= 60%`,
    detail ? `- detail: ${detail}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function renderPlanStatus(plan, state, detail = null) {
  return [
    "<!-- jarvis-plan-status -->",
    "**CONTINUOUS QUEUE PLAN STATUS**",
    `- plan_id: \`${plan.plan_id}\``,
    `- state: **${state}**`,
    `- heartbeat_utc: ${new Date().toISOString()}`,
    `- execution_surface: github_actions_continuous_queue`,
    `- target_queue_depth: ${plan.target_queue_depth}`,
    `- chat_blocking: false`,
    detail ? `- detail: ${detail}` : null,
  ].filter(Boolean).join("\n");
}

async function postStatus(job, state, step, detail = null) {
  await githubRequest(`/repos/${repository}/issues/${job.issueNumber}/comments`, {
    method: "POST",
    body: { body: renderStatus(job, state, step, detail) },
  });
}

async function postPlanStatus(plan, state, detail = null) {
  await githubRequest(`/repos/${repository}/issues/${plan.issueNumber}/comments`, {
    method: "POST",
    body: { body: renderPlanStatus(plan, state, detail) },
  });
}

async function closeIssue(job) {
  await githubRequest(`/repos/${repository}/issues/${job.issueNumber}`, {
    method: "PATCH",
    body: { state: "closed" },
  });
}

export async function collectCompletePages(fetchPage, label) {
  const records = [];
  for (let page = 1; page <= MAX_ISSUE_HISTORY_PAGES; page += 1) {
    const pageRecords = await fetchPage(page);
    if (!Array.isArray(pageRecords)) throw new Error(`invalid_${label}_response`);
    records.push(...pageRecords);
    if (pageRecords.length < ISSUE_PAGE_SIZE) return records;
  }
  throw new Error(`${label}_completeness_unproven`);
}

function exactStatusField(lines, field) {
  const prefix = `- ${field}: `;
  const matches = lines.filter((line) => line.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length) : null;
}

export function authenticTerminalState(comment, job, expectedRepository = repository) {
  if (comment?.user?.login !== "github-actions[bot]") return null;
  if (!job || !Number.isInteger(job.issueNumber) || !job.job_type || !job.canonical) return null;
  if (typeof expectedRepository !== "string" || !expectedRepository) return null;
  const lines = String(comment.body || "").split("\n");
  if (lines[0] !== "<!-- jarvis-queue-status -->") return null;
  if (lines[1] !== "**CONTINUOUS QUEUE STATUS**") return null;
  if (exactStatusField(lines, "status_epoch") !== STATUS_EPOCH) return null;

  const queueJobId = exactStatusField(lines, "queue_job_id");
  const queueJobIdPrefix = `\`${expectedRepository}#${job.issueNumber}/run-`;
  if (!queueJobId?.startsWith(queueJobIdPrefix) || !queueJobId.endsWith("`")) return null;
  const statusRunId = queueJobId.slice(queueJobIdPrefix.length, -1);
  if (!/^[0-9]+$/.test(statusRunId)) return null;
  if (exactStatusField(lines, "job_type") !== `\`${job.job_type}\``) return null;
  if (exactStatusField(lines, "task_identity") !== `\`${taskKey(job)}\``) return null;
  if (exactStatusField(lines, "execution_surface") !== "github_actions_continuous_queue") return null;
  if (exactStatusField(lines, "chat_blocking") !== "false") return null;

  for (const field of CANONICAL_PAYLOAD_KEYS) {
    const rendered = exactStatusField(lines, field);
    const expected = job.canonical[field];
    if (expected ? rendered !== `\`${expected}\`` : rendered !== null) return null;
  }

  const heartbeat = exactStatusField(lines, "heartbeat_utc");
  if (!heartbeat || !CANONICAL_UTC_RE.test(heartbeat) || new Date(heartbeat).toISOString() !== heartbeat) {
    return null;
  }
  const stateField = exactStatusField(lines, "state");
  const match = /^\*\*(SUCCEEDED|FAILED|REJECTED)\*\*$/.exec(stateField || "");
  return match && TERMINAL_STATES.has(match[1]) ? match[1] : null;
}

function uniqueAuthenticTerminalState(comments, job, expectedRepository) {
  const states = new Set(
    comments
      .map((comment) => authenticTerminalState(comment, job, expectedRepository))
      .filter(Boolean),
  );
  if (states.size > 1) throw new Error("ambiguous_terminal_status_history");
  return states.values().next().value ?? null;
}

export function hasAuthenticTerminalStatus(comments, job, expectedRepository = repository) {
  return uniqueAuthenticTerminalState(comments, job, expectedRepository) !== null;
}

async function listIssueComments(issueNumber) {
  return collectCompletePages(
    (page) => githubRequest(
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=${ISSUE_PAGE_SIZE}&page=${page}`,
    ),
    "issue_comment_history",
  );
}

async function hasTerminalQueueStatus(job) {
  return hasAuthenticTerminalStatus(
    await listIssueComments(job.issueNumber),
    job,
    repository,
  );
}

export function classifyIssuedIssue(
  issue,
  expectedTaskKey,
  comments,
  authorizedOwner,
  expectedRepository = repository,
) {
  let parsed;
  try {
    parsed = parseQueueJob(issue, authorizedOwner);
  } catch {
    return "INVALID_EVIDENCE";
  }
  if (taskKey(parsed) !== expectedTaskKey) return "INVALID_EVIDENCE";
  if (issue.state !== "closed") return "ACTIVE";
  let terminalState;
  try {
    terminalState = uniqueAuthenticTerminalState(comments, parsed, expectedRepository);
  } catch {
    return "INVALID_EVIDENCE";
  }
  return terminalState ? `TERMINAL_${terminalState}` : "UNVERIFIED";
}

async function runHeartbeat(job) {
  await postStatus(job, "RUNNING", "heartbeat acquired");
  await sleep(500);
  return "continuous queue heartbeat verified";
}

async function runAsyncContractSelfTest(job) {
  await postStatus(job, "RUNNING", "node contract tests");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--test", "runtime/async-jobs/contract.test.mjs"],
    { timeout: 120000, maxBuffer: 1024 * 1024, env: TOKENLESS_CHILD_ENV },
  );
  return (stdout || stderr || "contract tests passed").trim().slice(-500);
}

async function runRuntimeSyntaxSelfTest(job) {
  await postStatus(job, "RUNNING", "runtime syntax checks");
  await execFileAsync(process.execPath, ["--check", "runtime/async-jobs/worker.mjs"], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: TOKENLESS_CHILD_ENV,
  });
  await execFileAsync(process.execPath, ["--check", "runtime/continuous-queue/worker.mjs"], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: TOKENLESS_CHILD_ENV,
  });
  await execFileAsync(process.execPath, ["--check", "runtime/private-bridge/bridge.mjs"], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: TOKENLESS_CHILD_ENV,
  });
  return "runtime syntax checks passed";
}

async function runSustainedRhythmVerification(job) {
  const probe = job.payload?.probe;
  const holdMs = job.payload?.hold_ms ?? 100000;
  if (!Number.isInteger(holdMs) || holdMs < 90000 || holdMs > 120000) {
    throw new Error("invalid_sustained_rhythm_hold_ms");
  }
  if (!["runtime_syntax", "async_contract"].includes(probe)) {
    throw new Error("invalid_sustained_rhythm_probe");
  }
  await postStatus(job, "RUNNING", `sustained rhythm hold ${holdMs}ms before ${probe}`);
  await sleep(holdMs);
  if (probe === "runtime_syntax") return runRuntimeSyntaxSelfTest(job);
  return runAsyncContractSelfTest(job);
}

async function runPrivateBridge(job) {
  await postStatus(job, "RUNNING", "isolated short-lived private bridge");
  try {
    const receipt = await runPrivateInvestigationBridge({ job });
    return renderPublicBridgeReceipt(receipt);
  } catch (error) {
    if (error?.code === BRIDGE_BLOCKED) throw new Error(BRIDGE_BLOCKED);
    throw error;
  }
}

async function execute(job) {
  if (job.job_type === "heartbeat_probe") return runHeartbeat(job);
  if (job.job_type === "async_contract_self_test") return runAsyncContractSelfTest(job);
  if (job.job_type === "runtime_syntax_self_test") return runRuntimeSyntaxSelfTest(job);
  if (job.job_type === "sustained_rhythm_verification") return runSustainedRhythmVerification(job);
  if (job.job_type === BRIDGE_JOB_TYPE) return runPrivateBridge(job);
  throw new Error("unreachable_job_type");
}

async function listIssuesPage(state, creator, page) {
  if (!Number.isInteger(page) || page < 1) throw new Error("invalid_issue_page");
  return githubRequest(
    `/repos/${repository}/issues?state=${state}&creator=${encodeURIComponent(creator)}&sort=created&direction=asc&per_page=${ISSUE_PAGE_SIZE}&page=${page}`,
  );
}

async function listIssuesByCreator(state, creator) {
  return collectCompletePages(
    (page) => listIssuesPage(state, creator, page),
    `issue_history_${creator.replaceAll(/[^A-Za-z0-9]/g, "_")}`,
  );
}

function uniqueIssues(issueGroups) {
  const byNumber = new Map();
  for (const issue of issueGroups.flat()) {
    if (Number.isInteger(issue?.number)) byNumber.set(issue.number, issue);
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

async function listQueueIssues() {
  const issues = uniqueIssues(await Promise.all([
    listIssuesByCreator("open", repositoryOwner),
    listIssuesByCreator("open", "github-actions[bot]"),
  ]));
  return issues.filter((issue) =>
    !issue.pull_request && issue.title?.startsWith(QUEUE_PREFIX),
  );
}

export function assertNoDuplicateQueueTaskKeys(issues, authorizedOwner = repositoryOwner) {
  const issueByKey = new Map();
  for (const issue of issues) {
    let key;
    try {
      key = taskKey(parseQueueJob(issue, authorizedOwner));
    } catch {
      continue;
    }
    if (issueByKey.has(key)) throw new Error("ambiguous_open_queue_task_identity");
    issueByKey.set(key, issue.number);
  }
}

async function listPlanIssues() {
  const issues = await listIssuesByCreator("open", repositoryOwner);
  const candidates = issues.filter((issue) =>
    !issue.pull_request && issue.title?.startsWith(PLAN_PREFIX),
  );
  const fresh = [];
  for (const candidate of candidates) {
    fresh.push(await githubRequest(`/repos/${repository}/issues/${candidate.number}`));
  }
  return fresh;
}

async function listRecentQueueIssuesAllStates() {
  const issues = uniqueIssues(await Promise.all([
    listIssuesByCreator("all", repositoryOwner),
    listIssuesByCreator("all", "github-actions[bot]"),
  ]));
  return issues.filter((issue) =>
    !issue.pull_request && issue.title?.startsWith(QUEUE_PREFIX),
  );
}

async function createQueueIssue(plan, task) {
  const title = `${QUEUE_PREFIX} ${plan.plan_id} / ${task.canonical.cell_id}`;
  return githubRequest(`/repos/${repository}/issues`, {
    method: "POST",
    body: {
      title,
      body: JSON.stringify({
        schema_version: 1,
        producer: INTERNAL_PRODUCER,
        job_type: task.job_type,
        sensitivity: "public",
        payload: task.payload,
      }),
    },
  });
}

export function reconcilePlanState(
  plan,
  allQueue,
  { authorizedOwner, nowMs = Date.now() },
) {
  if (!Number.isFinite(nowMs)) throw new Error("invalid_reconciliation_time");
  const candidatesByKey = new Map();
  for (const issue of allQueue) {
    const key = queueTaskKeyFromIssue(issue, authorizedOwner);
    if (!key) continue;
    const candidates = candidatesByKey.get(key) ?? [];
    candidates.push(issue);
    candidatesByKey.set(key, candidates);
  }

  let changed = false;
  for (const task of plan.tasks) {
    const key = taskKey(task);
    const record = plan.issued.get(key);
    const candidates = candidatesByKey.get(key) ?? [];
    if (candidates.length > 1) throw new Error("ambiguous_task_history");
    if (record) {
      const reservedAtMs = reservationTimestampMs(record.reserved_at_utc);
      if (reservedAtMs > nowMs + 60_000) throw new Error("invalid_reservation_timestamp");
      if (record.issue_number) continue;
    }
    if (candidates.length === 1) {
      plan.issued.set(key, {
        issue_number: candidates[0].number,
        reserved_at_utc: record?.reserved_at_utc ?? new Date(nowMs).toISOString(),
      });
      changed = true;
      continue;
    }
    if (!record) continue;
    const reservedAtMs = reservationTimestampMs(record.reserved_at_utc);
    if (nowMs - reservedAtMs >= RESERVATION_LEASE_MS) {
      plan.issued.delete(key);
      changed = true;
    }
  }
  return changed;
}

export function planCompletionVerified(plan, remaining, inspection) {
  return remaining.length === 0
    && inspection.activeOrUnverified === 0
    && inspection.terminalSucceeded === plan.tasks.length
    && inspection.terminalFailed === 0
    && inspection.terminalRejected === 0
    && inspection.invalidEvidence === 0;
}

export function planTerminalOutcome(plan, remaining, inspection) {
  const failed = inspection.terminalFailed > 0
    || inspection.terminalRejected > 0
    || inspection.invalidEvidence > 0;
  if (failed) {
    return inspection.activeOrUnverified > 0
      ? "WAITING_FOR_TERMINAL_FAILURE_READBACK"
      : "FAILED";
  }
  return planCompletionVerified(plan, remaining, inspection) ? "COMPLETE" : null;
}

async function persistPlanDispatchState(plan) {
  const issued = {};
  for (const [key, record] of plan.issued.entries()) {
    issued[key] = {
      issue_number: record.issue_number ?? null,
      reserved_at_utc: record.reserved_at_utc ?? null,
    };
  }
  const body = {
    ...plan.raw_plan,
    dispatch_state: {
      schema_version: 1,
      issued,
    },
  };
  await githubRequest(`/repos/${repository}/issues/${plan.issueNumber}`, {
    method: "PATCH",
    body: { body: JSON.stringify(body) },
  });
  plan.raw_plan = body;
}

async function inspectPlanIssued(plan) {
  let activeOrUnverified = 0;
  let terminalSucceeded = 0;
  let terminalFailed = 0;
  let terminalRejected = 0;
  let invalidEvidence = 0;
  const issueNumbers = new Set();
  for (const [key, record] of plan.issued.entries()) {
    if (!record.issue_number) {
      activeOrUnverified += 1;
      continue;
    }
    issueNumbers.add(record.issue_number);
    const issue = await githubRequest(`/repos/${repository}/issues/${record.issue_number}`);
    const comments = issue.state === "closed"
      ? await listIssueComments(record.issue_number)
      : [];
    const classification = classifyIssuedIssue(issue, key, comments, repositoryOwner, repository);
    if (classification === "TERMINAL_SUCCEEDED") {
      terminalSucceeded += 1;
      continue;
    }
    if (classification === "TERMINAL_FAILED") {
      terminalFailed += 1;
      continue;
    }
    if (classification === "TERMINAL_REJECTED") {
      terminalRejected += 1;
      continue;
    }
    if (classification === "INVALID_EVIDENCE" || classification === "UNVERIFIED") {
      invalidEvidence += 1;
      continue;
    }
    if (classification !== "ACTIVE") {
      throw new Error("unknown_dispatch_issue_classification");
    }
    activeOrUnverified += 1;
  }
  return {
    activeOrUnverified,
    terminalSucceeded,
    terminalFailed,
    terminalRejected,
    invalidEvidence,
    issueNumbers,
  };
}

async function refillFromPlans() {
  const planIssues = await listPlanIssues();
  let completed = 0;
  for (const issue of planIssues) {
    let plan;
    try {
      plan = parsePlanIssue(issue);
    } catch (error) {
      const fallback = {
        issueNumber: issue.number,
        plan_id: `invalid-plan-${issue.number}`,
        target_queue_depth: DEFAULT_QUEUE_DEPTH,
      };
      await postPlanStatus(fallback, "REJECTED", String(error.message || error).slice(0, 300));
      await closeIssue(fallback);
      completed += 1;
      continue;
    }

    const allQueue = await listRecentQueueIssuesAllStates();
    if (reconcilePlanState(plan, allQueue, { authorizedOwner: repositoryOwner })) {
      await persistPlanDispatchState(plan);
    }
    const issuedKeys = new Set(plan.issued.keys());
    const remaining = plan.tasks.filter((task) => !issuedKeys.has(taskKey(task)));

    const inspection = await inspectPlanIssued(plan);
    const terminalOutcome = planTerminalOutcome(plan, remaining, inspection);
    if (terminalOutcome === "WAITING_FOR_TERMINAL_FAILURE_READBACK") {
        return {
          created: 0,
          completed,
          plan_id: plan.plan_id,
          state: "WAITING_FOR_TERMINAL_FAILURE_READBACK",
        };
    }
    if (terminalOutcome === "FAILED") {
      await postPlanStatus(
        plan,
        "FAILED",
        `finite plan stopped after failures=${inspection.terminalFailed}; rejected=${inspection.terminalRejected}; invalid_evidence=${inspection.invalidEvidence}`,
      );
      await closeIssue(plan);
      completed += 1;
      continue;
    }
    if (terminalOutcome === "COMPLETE") {
      await postPlanStatus(
        plan,
        "COMPLETE",
        `all finite plan tasks succeeded with durable terminal identity/readback; succeeded=${inspection.terminalSucceeded}`,
      );
      await closeIssue(plan);
      completed += 1;
      continue;
    }

    const openQueue = await listQueueIssues();
    const listedForeignOpen = openQueue.filter((candidate) => !inspection.issueNumbers.has(candidate.number)).length;
    const occupied = inspection.activeOrUnverified + listedForeignOpen;
    const slots = Math.max(0, plan.target_queue_depth - occupied);
    if (slots === 0 || remaining.length === 0) {
      return {
        created: 0,
        completed,
        plan_id: plan.plan_id,
        state: remaining.length === 0 ? "WAITING_FOR_TERMINAL_READBACK" : "QUEUE_DEPTH_SATISFIED",
      };
    }

    const selected = remaining.slice(0, slots);
    const reservedAt = new Date().toISOString();
    for (const task of selected) {
      plan.issued.set(taskKey(task), { issue_number: null, reserved_at_utc: reservedAt });
    }
    await persistPlanDispatchState(plan);

    const createdIssues = [];
    for (const task of selected) {
      const key = taskKey(task);
      const createdIssue = await createQueueIssue(plan, task);
      plan.issued.set(key, { issue_number: createdIssue.number, reserved_at_utc: reservedAt });
      await persistPlanDispatchState(plan);
      createdIssues.push(createdIssue.number);
    }
    await postPlanStatus(
      plan,
      "REFILLED",
      `reserved-before-side-effect; created queue issues ${createdIssues.join(", ")}; useful queue target ${plan.target_queue_depth}`,
    );
    return {
      created: createdIssues.length,
      created_issue_numbers: createdIssues,
      completed,
      plan_id: plan.plan_id,
      state: "REFILLED",
    };
  }
  return { created: 0, completed, plan_id: null, state: "NO_OPEN_PLAN" };
}

async function rejectAndClose(issue, error) {
  const fallback = {
    issueNumber: issue.number,
    job_type: "unknown",
    canonical: {},
  };
  await postStatus(fallback, "REJECTED", "contract gate", String(error.message || error).slice(0, 300));
  await closeIssue(fallback);
}

async function main() {
  const started = Date.now();
  const seenIssueNumbers = new Set();
  const directIssueNumbers = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let deduped = 0;
  let refilled = 0;
  let plansCompleted = 0;

  while (processed < MAX_JOBS_PER_RUN && Date.now() - started < MAX_RUNTIME_MS) {
    let issue = null;

    while (directIssueNumbers.length > 0 && !issue) {
      const issueNumber = directIssueNumbers.shift();
      if (seenIssueNumbers.has(issueNumber)) continue;
      const directIssue = await githubRequest(`/repos/${repository}/issues/${issueNumber}`);
      if (directIssue?.state === "open") issue = directIssue;
    }

    const issues = await listQueueIssues();
    assertNoDuplicateQueueTaskKeys(issues, repositoryOwner);
    if (!issue) {
      issue = issues.find((candidate) => !seenIssueNumbers.has(candidate.number)) || null;
    }

    if (!issue) {
      const refill = await refillFromPlans();
      refilled += refill.created;
      plansCompleted += refill.completed;
      if (refill.created > 0) {
        directIssueNumbers.push(...(refill.created_issue_numbers || []));
        continue;
      }
      break;
    }
    seenIssueNumbers.add(issue.number);

    let job;
    try {
      job = parseQueueJob(issue);
    } catch (error) {
      await rejectAndClose(issue, error);
      processed += 1;
      failed += 1;
      continue;
    }

    if (await hasTerminalQueueStatus(job)) {
      await closeIssue(job);
      deduped += 1;
      continue;
    }

    await postStatus(job, "ACCEPTED", "direct external handoff acquired");
    try {
      const result = await execute(job);
      await postStatus(job, "SUCCEEDED", "complete; same-run next task/refill eligible immediately", result);
      succeeded += 1;
    } catch (error) {
      await postStatus(job, "FAILED", "execution; local failure isolated; same-run next task still eligible", String(error.message || error).slice(0, 300));
      failed += 1;
    }
    await closeIssue(job);
    processed += 1;
  }

  const queueRemaining = (await listQueueIssues()).length;
  const plansRemaining = (await listPlanIssues()).length;
  const bounded = processed >= MAX_JOBS_PER_RUN || Date.now() - started >= MAX_RUNTIME_MS;
  const nextState = bounded
    ? "BOUNDED_RUN_LIMIT_REACHED"
    : queueRemaining > 0
      ? "QUEUED_WORK_REMAINS"
      : plansRemaining > 0
        ? "PLAN_PENDING_REFILL_OR_DRAIN"
        : "WARM_STANDBY_NO_DEMAND";

  const continuationMode = bounded && (queueRemaining > 0 || plansRemaining > 0)
    ? "NEXT_FIVE_MINUTE_SCHEDULE_TICK"
    : "NOT_REQUIRED";

  console.log(JSON.stringify({
    queue_run_id: runId,
    processed,
    succeeded,
    failed,
    deduped,
    refilled,
    plans_completed: plansCompleted,
    queue_remaining: queueRemaining,
    plans_remaining: plansRemaining,
    next_state: nextState,
    continuation_mode: continuationMode,
    chat_blocking: false,
    reserve_min_pct: 60,
  }));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadRuntimeEnvironment();
  await main();
}
