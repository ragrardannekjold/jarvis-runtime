import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const QUEUE_PREFIX = "[QUEUE-JOB]";
const PLAN_PREFIX = "[QUEUE-PLAN]";
const TERMINAL_STATUS_RE = /- state: \*\*(SUCCEEDED|FAILED|REJECTED)\*\*/;
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
const DEFAULT_QUEUE_DEPTH = 2;
const MAX_QUEUE_DEPTH = 4;
const MAX_PLAN_TASKS = 32;

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

function validateTaskSpec(task, { requireCanonical = false } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("invalid_task");
  if (!ALLOWED_JOB_TYPES.has(task.job_type)) throw new Error("job_type_not_allowlisted");
  const payload = task.payload ?? {};
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
  return { job_type: task.job_type, payload, canonical };
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
  if (job.payload_ref !== undefined) throw new Error("private_payload_ref_not_enabled");

  const spec = validateTaskSpec(job);
  return {
    issueNumber: issue.number,
    ...spec,
  };
}

function parsePlanIssue(issue) {
  if (!issue?.number || issue.pull_request) throw new Error("not_plan_issue");
  if (!issue.title?.startsWith(PLAN_PREFIX)) throw new Error("not_plan_title");
  if (issue.user?.login !== repositoryOwner) throw new Error("plan_owner_mismatch");

  let plan;
  try {
    plan = JSON.parse(issue.body || "{}");
  } catch {
    throw new Error("invalid_plan_json");
  }
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
  return {
    issueNumber: issue.number,
    plan_id: planId,
    target_queue_depth: targetQueueDepth,
    tasks,
  };
}

function taskKey(task) {
  return [
    task.job_type,
    task.canonical?.mission_id || "",
    task.canonical?.route_id || "",
    task.canonical?.cell_id || "",
  ].join("|");
}

function queueTaskKeyFromIssue(issue) {
  try {
    return taskKey(parseQueueJob(issue));
  } catch {
    return null;
  }
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

async function hasTerminalQueueStatus(issueNumber) {
  const comments = await githubRequest(`/repos/${repository}/issues/${issueNumber}/comments?per_page=100`);
  return (comments || []).some((comment) => {
    const body = comment?.body || "";
    return body.includes("<!-- jarvis-queue-status -->") && TERMINAL_STATUS_RE.test(body);
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

async function listIssues(state = "open") {
  return githubRequest(`/repos/${repository}/issues?state=${state}&sort=created&direction=asc&per_page=100`);
}

async function listQueueIssues() {
  const issues = await listIssues("open");
  return (issues || []).filter((issue) =>
    !issue.pull_request && issue.title?.startsWith(QUEUE_PREFIX),
  );
}

async function listPlanIssues() {
  const issues = await listIssues("open");
  return (issues || []).filter((issue) =>
    !issue.pull_request && issue.title?.startsWith(PLAN_PREFIX),
  );
}

async function listRecentQueueIssuesAllStates() {
  const issues = await listIssues("all");
  return (issues || []).filter((issue) =>
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
        job_type: task.job_type,
        sensitivity: "public",
        payload: task.payload,
      }),
    },
  });
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

    const openQueue = await listQueueIssues();
    const allQueue = await listRecentQueueIssuesAllStates();
    const seenKeys = new Set(allQueue.map(queueTaskKeyFromIssue).filter(Boolean));
    const remaining = plan.tasks.filter((task) => !seenKeys.has(taskKey(task)));

    if (remaining.length === 0) {
      if (openQueue.length === 0) {
        await postPlanStatus(plan, "COMPLETE", "all finite plan tasks have terminal or historical queue identity");
        await closeIssue(plan);
        completed += 1;
        continue;
      }
      return { created: 0, completed, plan_id: plan.plan_id, state: "WAITING_FOR_ACTIVE_QUEUE" };
    }

    const slots = Math.max(0, plan.target_queue_depth - openQueue.length);
    if (slots === 0) {
      return { created: 0, completed, plan_id: plan.plan_id, state: "QUEUE_DEPTH_SATISFIED" };
    }

    const selected = remaining.slice(0, slots);
    const createdIssues = [];
    for (const task of selected) {
      const createdIssue = await createQueueIssue(plan, task);
      createdIssues.push(createdIssue.number);
    }
    await postPlanStatus(
      plan,
      "REFILLED",
      `created queue issues ${createdIssues.join(", ")}; useful queue target ${plan.target_queue_depth}`,
    );
    return { created: createdIssues.length, completed, plan_id: plan.plan_id, state: "REFILLED" };
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
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let deduped = 0;
  let refilled = 0;
  let plansCompleted = 0;

  while (processed < MAX_JOBS_PER_RUN && Date.now() - started < MAX_RUNTIME_MS) {
    const issues = await listQueueIssues();
    const issue = issues.find((candidate) => !seenIssueNumbers.has(candidate.number));
    if (!issue) {
      const refill = await refillFromPlans();
      refilled += refill.created;
      plansCompleted += refill.completed;
      if (refill.created > 0) continue;
      break;
    }
    seenIssueNumbers.add(issue.number);

    if (await hasTerminalQueueStatus(issue.number)) {
      await closeIssue({ issueNumber: issue.number });
      deduped += 1;
      continue;
    }

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
    chat_blocking: false,
    reserve_min_pct: 60,
  }));
}

await main();
