import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseJobBody, buildStatus, extractCanonicalIds } from "./contract.mjs";

const execFileAsync = promisify(execFile);

function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("missing_github_event_path");
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

async function githubRequest(path, { method = "GET", body } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("missing_github_token");
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-runtime-async-worker",
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

function renderStatus(status) {
  return [
    "<!-- jarvis-async-status -->",
    "**ASYNC JOB STATUS**",
    `- job_id: \`${status.job_id}\``,
    status.mission_id ? `- mission_id: \`${status.mission_id}\`` : null,
    status.route_id ? `- route_id: \`${status.route_id}\`` : null,
    status.cell_id ? `- cell_id: \`${status.cell_id}\`` : null,
    `- state: **${status.state}**`,
    `- step: ${status.step}`,
    `- heartbeat_utc: ${status.heartbeat_utc}`,
    `- checkpoint_ref: ${status.checkpoint_ref}`,
    `- execution_surface: ${status.execution_surface}`,
    `- chat_blocking: ${status.chat_blocking}`,
    `- policy_target: foreground <= ${status.policy_target.foreground_control_plane_max_pct}% / reserve >= ${status.policy_target.reserve_min_pct}%`,
    status.detail ? `- detail: ${status.detail}` : null,
  ].filter(Boolean).join("\n");
}

async function postStatus(context, state, step, detail = null) {
  const status = buildStatus({
    repository: context.repository,
    issueNumber: context.issueNumber,
    runId: context.runId,
    state,
    step,
    detail,
    canonical: context.canonical,
  });
  await githubRequest(`/repos/${context.repository}/issues/${context.issueNumber}/comments`, {
    method: "POST",
    body: { body: renderStatus(status) },
  });
  console.log(JSON.stringify(status));
  return status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runHeartbeatProbe(context) {
  await postStatus(context, "RUNNING", "1/2 external worker acquired");
  await sleep(2000);
  await postStatus(context, "RUNNING", "2/2 heartbeat confirmed");
  await sleep(1000);
  return "external worker heartbeat path verified";
}

async function runUtilitySearchSelfTest(context) {
  await postStatus(context, "RUNNING", "1/3 install utility-search dependencies");
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: "plugin/utility-search",
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    },
  );
  await postStatus(context, "RUNNING", "2/3 execute utility-search tests");
  const { stdout } = await execFileAsync("npm", ["test"], {
    cwd: "plugin/utility-search",
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  await postStatus(context, "RUNNING", "3/3 tests complete", stdout.trim().slice(-240));
  return "utility-search tests passed on external GitHub runner";
}

async function runIntentionalFailureProbe(context) {
  await postStatus(context, "RUNNING", "1/1 intentional failure armed", "safe canary failure; no external side effect");
  throw new Error("intentional_canary_failure");
}

function latestFailedCheckpoint(comments) {
  return [...comments].reverse().find((comment) => {
    const body = comment?.body || "";
    return body.includes("<!-- jarvis-async-status -->") &&
      /- state: \*\*(FAILED|REJECTED)\*\*/.test(body);
  });
}

function missionFromStatus(body) {
  return body.match(/- mission_id: `([^`]+)`/)?.[1] ?? null;
}

async function runCheckpointRecoveryProbe(context, job) {
  const recoveredIssue = Number(job.payload.recovered_from_issue);
  if (!Number.isInteger(recoveredIssue) || recoveredIssue <= 0) {
    throw new Error("invalid_recovered_from_issue");
  }
  if (!context.canonical.mission_id) throw new Error("recovery_requires_canonical_ids");

  await postStatus(context, "RUNNING", "1/3 load prior checkpoint", `source_issue=${recoveredIssue}`);
  const comments = await githubRequest(`/repos/${context.repository}/issues/${recoveredIssue}/comments?per_page=100`);
  const checkpoint = latestFailedCheckpoint(comments || []);
  if (!checkpoint) throw new Error("failed_checkpoint_not_found");

  const priorMission = missionFromStatus(checkpoint.body || "");
  if (priorMission !== context.canonical.mission_id) {
    throw new Error("checkpoint_mission_mismatch");
  }

  await postStatus(context, "RUNNING", "2/3 failed checkpoint verified", `source_issue=${recoveredIssue}`);
  await sleep(500);
  await postStatus(context, "RUNNING", "3/3 resume path confirmed", `source_issue=${recoveredIssue}`);
  return `checkpoint recovery verified from issue #${recoveredIssue}`;
}

async function closeIssue(context) {
  await githubRequest(`/repos/${context.repository}/issues/${context.issueNumber}`, {
    method: "PATCH",
    body: { state: "closed" },
  });
}

async function main() {
  const event = readEvent();
  const issue = event.issue;
  if (!issue?.number) throw new Error("missing_issue_event");

  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) throw new Error("missing_github_runtime_identity");

  const rawBody = issue.body || "";
  const context = {
    repository,
    runId,
    issueNumber: issue.number,
    canonical: extractCanonicalIds(rawBody),
  };
  let job;
  try {
    job = parseJobBody(rawBody);
    context.canonical = job.canonical;
  } catch (error) {
    await postStatus(context, "REJECTED", "contract gate", error.message);
    process.exitCode = 2;
    return;
  }

  try {
    await postStatus(context, "ACCEPTED", `job_type=${job.job_type}`);
    let result;
    if (job.job_type === "heartbeat_probe") result = await runHeartbeatProbe(context);
    else if (job.job_type === "utility_search_self_test") result = await runUtilitySearchSelfTest(context);
    else if (job.job_type === "intentional_failure_probe") result = await runIntentionalFailureProbe(context);
    else if (job.job_type === "checkpoint_recovery_probe") result = await runCheckpointRecoveryProbe(context, job);
    else throw new Error("unreachable_job_type");

    await postStatus(context, "SUCCEEDED", "complete", result);
    await closeIssue(context);
  } catch (error) {
    await postStatus(context, "FAILED", "execution", String(error.message || error).slice(0, 300));
    process.exitCode = 1;
  }
}

await main();
