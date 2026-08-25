import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const QUEUE_PREFIX = "[QUEUE-JOB]";
const PLAN_PREFIX = "[QUEUE-PLAN]";
const INTERNAL_PRODUCER = "continuous_queue_refill_v1";
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
const ISSUE_PAGE_SIZE = 100;
const MAX_ISSUE_HISTORY_PAGES = 100;

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

  let job;
  try {
    job = JSON.parse(issue.body || "{}");
  } catch {
    throw new Error("invalid_json");
  }

  const ownerAuthorized = issue.user?.login === repositoryOwner;
  const internalAuthorized = issue.user?.login === "github-actions[bot]" && job.producer === INTERNAL_PRODUCER;
  if (!ownerAuthorized && !internalAuthorized) throw new Error("queue_producer_not_authorized");

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

  const dispatchState = plan.dispatch_state ?? { schema_version: 1, issued: {} };
  if (!dispatchState || typeof dispatchState !== "object" || Array.isArray(dispatchState)) {
    throw new Error("invalid_dispatch_state");
  }
  if (dispatchState.schema_version !== 1) throw new Error("unsupported_dispatch_state_schema_version");
  if (!dispatchState.issued || typeof dispatchState.issued !== "object" || Array.isArray(dispatchState.issued)) {
    throw new Error("invalid_dispatch_issued_map");
  }
  const issued = new Map();
  for (const [key, record] of Object.entries(dispatchState.issued)) {
    if (!keys.includes(key)) throw new Error("dispatch_issued_key_not_in_plan");
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid_dispatch_record");
    const issueNumber = record.issue_number ?? null;
    if (issueNumber !== null && (!Number.isInteger(issueNumber) || issueNumber < 1)) {
      throw new Error("invalid_dispatch_issue_number");
    }
    issued.set(key, {
      issue_number: issueNumber,
      reserved_at_utc: typeof record.reserved_at_utc === "string" ? record.reserved_at_utc : null,
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

async function listIssuesPage(state = "open", page = 1) {
  if (!Number.isInteger(page) || page < 1) throw new Error("invalid_issue_page");
  return githubRequest(
    `/repos/${repository}/issues?state=${state}&sort=created&direction=asc&per_page=${ISSUE_PAGE_SIZE}&page=${page}`,
  );
}

async function listIssues(state = "open") {
  const allIssues = [];
  for (let page = 1; page <= MAX_ISSUE_HISTORY_PAGES; page += 1) {
    const pageIssues = await listIssuesPage(state, page);
    if (!Array.isArray(pageIssues)) throw new Error("invalid_issue_history_response");
    allIssues.push(...pageIssues);
    if (pageIssues.length < ISSUE_PAGE_SIZE) return allIssues;
  }
  throw new Error("issue_history_completeness_unproven");
}

async function listQueueIssues() {
  const issues = await listIssues("open");
  return (issues || []).filter((issue) =>
    !issue.pull_request && issue.title?.startsWith(QUEUE_PREFIX),
  );
}

async function listPlanIssues() {
  const issues = await listIssues("open");
  const candidates = (issues || []).filter((issue) =>
    !issue.pull_request && issue.title?.startsWith(PLAN_PREFIX),
  );
  const fresh = [];
  for (const candidate of candidates) {
    fresh.push(await githubRequest(`/repos/${repository}/issues/${candidate.number}`));
  }
  return fresh;
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
        producer: INTERNAL_PRODUCER,
        job_type: task.job_type,
        sensitivity: "public",
        payload: task.payload,
      }),
    },
  });
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
  let terminalVerified = 0;
  const issueNumbers = new Set();
  for (const [key, record] of plan.issued.entries()) {
    if (!record.issue_number) {
      activeOrUnverified += 1;
      continue;
    }
    issueNumbers.add(record.issue_number);
    const issue = await githubRequest(`/repos/${repository}/issues/${record.issue_number}`);
    const parsed = parseQueueJob(issue);
    if (taskKey(parsed) !== key) throw new Error("dispatch_issue_identity_mismatch");
    if (issue.state !== "closed") {
      activeOrUnverified += 1;
      continue;
    }
    if (!(await hasTerminalQueueStatus(record.issue_number))) {
      activeOrUnverified += 1;
      continue;
    }
    terminalVerified += 1;
  }
  return { activeOrUnverified, terminalVerified, issueNumbers };
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
    const historicalSeen = new Set(allQueue.map(queueTaskKeyFromIssue).filter(Boolean));
    const issuedKeys = new Set(plan.issued.keys());
    const remaining = plan.tasks.filter((task) => {
      const key = taskKey(task);
      return !issuedKeys.has(key) && !historicalSeen.has(key);
    });

    const inspection = await inspectPlanIssued(plan);
    if (remaining.length === 0 && inspection.activeOrUnverified === 0) {
      await postPlanStatus(
        plan,
        "COMPLETE",
        `all finite plan tasks have durable terminal identity/readback; verified=${inspection.terminalVerified}`,
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
