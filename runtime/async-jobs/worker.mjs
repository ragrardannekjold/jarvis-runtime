import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseJobBody, buildStatus } from "./contract.mjs";

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
    `- state: **${status.state}**`,
    `- step: ${status.step}`,
    `- heartbeat_utc: ${status.heartbeat_utc}`,
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
  });
  await githubRequest(`/repos/${context.repository}/issues/${context.issueNumber}/comments`, {
    method: "POST",
    body: { body: renderStatus(status) },
  });
  console.log(JSON.stringify(status));
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

  const context = { repository, runId, issueNumber: issue.number };
  let job;
  try {
    job = parseJobBody(issue.body || "");
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
    else throw new Error("unreachable_job_type");

    await postStatus(context, "SUCCEEDED", "complete", result);
    await closeIssue(context);
  } catch (error) {
    await postStatus(context, "FAILED", "execution", String(error.message || error).slice(0, 300));
    process.exitCode = 1;
  }
}

await main();
