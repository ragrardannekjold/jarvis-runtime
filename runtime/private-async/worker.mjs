import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parsePublicTrigger, parsePrivateJob, buildPublicStatus } from "./contract.mjs";
import { runAi39CybintRefresh } from "./ai39_cybint.mjs";
import { runAi39RtoAsCompare } from "./ai39_rto_as_compare.mjs";

const execFileAsync = promisify(execFile);
const PRIVATE_REPO = "ragrardannekjold/jarvis-command-center";
const PRIVATE_BRANCH = "main";
const PRIVATE_JOB_ROOT = "automation/private_async/jobs";
const PRIVATE_RESULT_ROOT = "automation/private_async/results";
const OWNER_LOGIN = "ragrardannekjold";

function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("missing_github_event_path");
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

async function request(url, token, { method = "GET", body, allowNotFound = false, allowConflict = false } = {}) {
  if (!token) throw new Error("missing_token");
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-private-async-bridge",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (allowNotFound && response.status === 404) return null;
  if (allowConflict && [409, 422].includes(response.status)) return { conflict: true };
  if (!response.ok) {
    throw new Error(`github_api_${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function privateContentsUrl(path) {
  return `https://api.github.com/repos/${PRIVATE_REPO}/contents/${path}?ref=${PRIVATE_BRANCH}`;
}

async function fetchPrivateJson(path, token, { allowNotFound = false } = {}) {
  const result = await request(privateContentsUrl(path), token, { allowNotFound });
  if (!result) return null;
  if (result.encoding !== "base64" || typeof result.content !== "string") {
    throw new Error("unexpected_private_content_encoding");
  }
  const raw = Buffer.from(result.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { data: JSON.parse(raw), sha: result.sha };
}

async function putPrivateJson(path, value, token, { sha = null, allowConflict = false } = {}) {
  const body = {
    message: `private async: update ${path.split("/").at(-1)}`,
    content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8").toString("base64"),
    branch: PRIVATE_BRANCH,
  };
  if (sha) body.sha = sha;
  return request(`https://api.github.com/repos/${PRIVATE_REPO}/contents/${path}`, token, {
    method: "PUT",
    body,
    allowConflict,
  });
}

function renderPublicStatus(status) {
  return [
    "<!-- jarvis-private-async-status -->",
    "**PRIVATE ASYNC STATUS**",
    `- job_id: \`${status.job_id}\``,
    `- job_ref: \`${status.job_ref}\``,
    `- state: **${status.state}**`,
    `- step: ${status.step}`,
    `- heartbeat_utc: ${status.heartbeat_utc}`,
    `- execution_surface: ${status.execution_surface}`,
    `- chat_blocking: ${status.chat_blocking}`,
    `- public_payload_exposed: ${status.public_payload_exposed}`,
    `- public_result_exposed: ${status.public_result_exposed}`,
    `- policy_target: foreground <= ${status.policy_target.foreground_control_plane_max_pct}% / reserve >= ${status.policy_target.reserve_min_pct}%`,
  ].join("\n");
}

async function postPublicStatus(context, state, step) {
  const status = buildPublicStatus({
    repository: context.repository,
    issueNumber: context.issueNumber,
    runId: context.runId,
    jobRef: context.jobRef,
    state,
    step,
  });
  await request(
    `https://api.github.com/repos/${context.repository}/issues/${context.issueNumber}/comments`,
    context.publicToken,
    { method: "POST", body: { body: renderPublicStatus(status) } },
  );
}

async function closePublicIssue(context) {
  await request(
    `https://api.github.com/repos/${context.repository}/issues/${context.issueNumber}`,
    context.publicToken,
    { method: "PATCH", body: { state: "closed", state_reason: "completed" } },
  );
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function runCommandCenterValidation() {
  const commands = [
    ["scripts/validate_recovery_floor.py"],
    ["scripts/validate_stable_operating_state.py"],
  ];
  const receipts = [];
  for (const args of commands) {
    const { stdout = "", stderr = "" } = await execFileAsync("python", args, {
      cwd: "command-center",
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    });
    receipts.push({
      command: args[0],
      output_sha256: digest({ stdout, stderr }),
    });
  }
  return { validation_receipts: receipts };
}

async function executePrivateJob(job) {
  if (job.job_type === "private_integrity_probe") {
    return { integrity_probe: "PASS" };
  }
  if (job.job_type === "command_center_validation") {
    return runCommandCenterValidation();
  }
  if (job.job_type === "ai39_cybint_refresh") {
    return runAi39CybintRefresh(job.payload);
  }
  if (job.job_type === "ai39_rto_as_compare") {
    return runAi39RtoAsCompare(job.payload);
  }
  throw new Error("unreachable_private_job_type");
}

async function main() {
  const event = readEvent();
  const issue = event.issue;
  if (!issue?.number) throw new Error("missing_issue_event");
  if (issue.user?.login !== OWNER_LOGIN) return;

  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const publicToken = process.env.GITHUB_TOKEN;
  const privateToken = process.env.COMMAND_CENTER_TOKEN;
  if (!repository || !runId || !publicToken || !privateToken) {
    throw new Error("missing_runtime_identity_or_token");
  }

  let trigger;
  try {
    trigger = parsePublicTrigger(issue.body || "");
  } catch {
    const provisional = {
      repository,
      runId,
      issueNumber: issue.number,
      jobRef: "invalid",
      publicToken,
    };
    await postPublicStatus(provisional, "REJECTED", "opaque-reference contract gate");
    return;
  }

  const context = {
    repository,
    runId,
    issueNumber: issue.number,
    jobRef: trigger.job_ref,
    publicToken,
    privateToken,
  };

  await postPublicStatus(context, "ACCEPTED", "opaque reference accepted");

  const jobPath = `${PRIVATE_JOB_ROOT}/${trigger.job_ref}.json`;
  const resultPath = `${PRIVATE_RESULT_ROOT}/${trigger.job_ref}.json`;

  const existing = await fetchPrivateJson(resultPath, privateToken, { allowNotFound: true });
  if (existing) {
    const existingState = existing.data?.status;
    if (existingState === "SUCCEEDED") {
      await postPublicStatus(context, "SUCCEEDED", "existing private terminal result reused");
      await closePublicIssue(context);
    } else {
      await postPublicStatus(context, "REJECTED", "duplicate or previously attempted private job");
    }
    return;
  }

  await postPublicStatus(context, "RUNNING", "private job reference resolving");
  let job;
  try {
    const privateJob = await fetchPrivateJson(jobPath, privateToken);
    job = parsePrivateJob(privateJob.data, trigger.job_ref);
  } catch {
    await postPublicStatus(context, "FAILED", "private job contract or lookup failed");
    return;
  }

  const payloadSha256 = digest(job.payload);
  const startedAt = new Date().toISOString();
  const claim = {
    schema_version: 1,
    job_ref: job.job_ref,
    job_type: job.job_type,
    status: "RUNNING",
    started_at: startedAt,
    finished_at: null,
    public_run_id: String(runId),
    public_issue_number: issue.number,
    payload_sha256: payloadSha256,
    output: null,
  };

  const claimWrite = await putPrivateJson(resultPath, claim, privateToken, { allowConflict: true });
  if (claimWrite?.conflict) {
    await postPublicStatus(context, "REJECTED", "duplicate private execution claim");
    return;
  }
  const resultSha = claimWrite?.content?.sha;
  if (!resultSha) throw new Error("missing_private_claim_sha");

  await postPublicStatus(context, "RUNNING", "private execution acquired");

  try {
    const output = await executePrivateJob(job);
    const terminal = {
      ...claim,
      status: "SUCCEEDED",
      finished_at: new Date().toISOString(),
      output,
    };
    await putPrivateJson(resultPath, terminal, privateToken, { sha: resultSha });
    await postPublicStatus(context, "SUCCEEDED", "private terminal readback persisted");
    await closePublicIssue(context);
  } catch {
    const terminal = {
      ...claim,
      status: "FAILED",
      finished_at: new Date().toISOString(),
      output: { error_code: "PRIVATE_EXECUTION_FAILED" },
    };
    await putPrivateJson(resultPath, terminal, privateToken, { sha: resultSha });
    await postPublicStatus(context, "FAILED", "private terminal failure persisted");
    process.exitCode = 1;
  }
}

await main();
