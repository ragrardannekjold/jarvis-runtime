import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const QUEUE_PREFIX = "[QUEUE-JOB]";
const ALLOWED_JOB_TYPES = new Set([
  "heartbeat_probe",
  "async_contract_self_test",
  "runtime_syntax_self_test",
  "utility_search_self_test",
]);
const CANONICAL_ID_RE = /^[A-Za-z0-9._:/#-]{1,128}$/;
const MAX_PAYLOAD_BYTES = 2048;
const MAX_JOBS_PER_RUN = 8;
const MAX_RUNTIME_MS = 8 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

const repository = env("GITHUB_REPOSITORY");
const repositoryOwner = env("REPOSITORY_OWNER");
const token = env("GITHUB_TOKEN");
const runId = env("GITHUB_RUN_ID");

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

function parseQueueJob(issue) {
  if (!issue?.number || issue.pull_request) throw new Error("not_queue_issue");
  if (!issue.title?.startsWith(QUEUE_PREFIX)) throw new Error("not_queue_title");
  if (issue.user?.login !== repositoryOwner) throw new Error("queue_owner_mismatch");

  let job;
  try {
    job = JSON.parse(issue.body || "{}");
  } catch {
    throw new Error("invalid_json");
  }

  if (job.schema_version !== 1) throw new Error("unsupported_schema_version");
  if (job.sensitivity !== "public") throw new Error("public_queue_requires_public_sensitivity");
  if (!ALLOWED_JOB_TYPES.has(job.job_type)) throw new Error("job_type_not_allowlisted");
  if (job.payload_ref !== undefined) throw new Error("private_payload_ref_not_enabled");

  const payload = job.payload ?? {};
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

  return {
    issueNumber: issue.number,
    job_type: job.job_type,
    payload,
    canonical,
  };
}

function renderStatus(job, state, step, detail = null) {
  const lines = [
    "<!-- jarvis-queue-status -->",
    "**CONTINUOUS QUEUE STATUS**",
    `- queue_job_id: \`${repository}#${job.issueNumber}/run-${runId}\``,
    job.canonical.mission_id ? `- mission_id: \`${job.canonical.mission_id}\`` : null,
    job.canonical.route_id ? `- route_id: \`${job.canonical.route_id}\`` : null,
    job.canonical.cell_id ? `- cell_id: \`${job.canonical.cell_id}\`` : null,
    `- job_type: \`${job.job_type}\``,
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

async function postStatus(job, state, step, detail = null) {
  await githubRequest(`/repos/${repository}/issues/${job.issueNumber}/comments`, {
    method: "POST",
    body: { body: renderStatus(job, state, step, detail) },
  });
}

async function closeIssue(job) {
  await githubRequest(`/repos/${repository}/issues/${job.issueNumber}`, {
    method: "PATCH",
    body: { state: "closed" },
  });
}

async function runHeartbeat(job) {
  await postStatus(job, "RUNNING", "heartbeat acquired");
  await sleep(500);
  return "continuous queue heartbeat verified";
}

async function runAsyncContractSelfTest(job) {
  await postStatus(job, "RUNNING", "node contract tests");
  const { stdout, stderr } = await execFileAsync(
    "node",
    ["--test", "runtime/async-jobs/contract.test.mjs"],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  return (stdout || stderr || "contract tests passed").trim().slice(-500);
}

async function runRuntimeSyntaxSelfTest(job) {
  await postStatus(job, "RUNNING", "runtime syntax checks");
  await execFileAsync("node", ["--check", "runtime/async-jobs/worker.mjs"], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  await execFileAsync("node", ["--check", "runtime/continuous-queue/worker.mjs"], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  return "runtime syntax checks passed";
}

async function runUtilitySearchSelfTest(job) {
  await postStatus(job, "RUNNING", "install utility-search dependencies");
  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: "plugin/utility-search",
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  await postStatus(job, "RUNNING", "execute utility-search tests");
  const { stdout } = await execFileAsync("npm", ["test"], {
    cwd: "plugin/utility-search",
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim().slice(-500);
}

async function execute(job) {
  if (job.job_type === "heartbeat_probe") return runHeartbeat(job);
  if (job.job_type === "async_contract_self_test") return runAsyncContractSelfTest(job);
  if (job.job_type === "runtime_syntax_self_test") return runRuntimeSyntaxSelfTest(job);
  if (job.job_type === "utility_search_self_test") return runUtilitySearchSelfTest(job);
  throw new Error("unreachable_job_type");
}

async function listQueueIssues() {
  const issues = await githubRequest(
    `/repos/${repository}/issues?state=open&sort=created&direction=asc&per_page=100`,
  );
  return (issues || []).filter((issue) =>
    !issue.pull_request && issue.title?.startsWith(QUEUE_PREFIX),
  );
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
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  while (processed < MAX_JOBS_PER_RUN && Date.now() - started < MAX_RUNTIME_MS) {
    const issues = await listQueueIssues();
    const issue = issues[0];
    if (!issue) break;

    let job;
    try {
      job = parseQueueJob(issue);
    } catch (error) {
      await rejectAndClose(issue, error);
      processed += 1;
      failed += 1;
      continue;
    }

    await postStatus(job, "ACCEPTED", "dequeued as next safe external task");
    try {
      const result = await execute(job);
      await postStatus(job, "SUCCEEDED", "complete; next queue item eligible immediately", result);
      succeeded += 1;
    } catch (error) {
      await postStatus(job, "FAILED", "execution; local failure isolated; next queue item still eligible", String(error.message || error).slice(0, 300));
      failed += 1;
    }
    await closeIssue(job);
    processed += 1;
  }

  console.log(JSON.stringify({
    queue_run_id: runId,
    processed,
    succeeded,
    failed,
    next_state: processed >= MAX_JOBS_PER_RUN || Date.now() - started >= MAX_RUNTIME_MS
      ? "BOUNDED_RUN_LIMIT_REACHED"
      : "WARM_STANDBY_NO_QUEUED_WORK",
    chat_blocking: false,
    reserve_min_pct: 60,
  }));
}

await main();
