import { createHash } from "node:crypto";

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const HEALTHY_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

function fail(code) {
  throw new Error(code);
}

function timestamp(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`invalid_${field}`);
  return parsed;
}

function boundedString(value, field, max = 200) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) {
    fail(`invalid_${field}`);
  }
  return value;
}

function runIdentity(run) {
  if (!Number.isInteger(run.id) || run.id < 1) fail("invalid_run_id");
  if (!Number.isInteger(run.workflow_id) || run.workflow_id < 1) fail("invalid_workflow_id");
  boundedString(run.name, "workflow_name", 200);
  boundedString(run.status, "run_status", 40);
  boundedString(run.html_url, "run_url", 500);
  timestamp(run.created_at, "run_created_at");
  return run;
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function incidentFingerprint(workflowId, incidentClass) {
  return `gha:v1:${sha256(`${workflowId}|${incidentClass}`).slice(0, 32)}`;
}

function activeState(run, incidentClass, reason) {
  return {
    state: "ACTIVE_FAILURE",
    incident_class: incidentClass,
    reason,
    fingerprint: incidentFingerprint(run.workflow_id, incidentClass),
    workflow_id: run.workflow_id,
    workflow_name: run.name,
    latest_run_id: run.id,
    latest_run_url: run.html_url,
    observed_at: run.updated_at || run.created_at,
  };
}

export function classifyWorkflowRuns(runs, {
  now = new Date(),
  expectedCancelledWorkflows = [],
  decommissionedWorkflowIds = [],
  decommissionedWorkflowNames = [],
  graceMs = 60_000,
  staleMs = 30 * 60_000,
  ignoredWorkflowNames = ["Runtime Anomaly Sentinel"],
} = {}) {
  if (!Array.isArray(runs)) fail("invalid_runs");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) fail("invalid_now");
  const expectedCancelled = new Set(expectedCancelledWorkflows);
  const decommissionedIds = new Set(decommissionedWorkflowIds);
  const decommissionedNames = new Set(decommissionedWorkflowNames);
  const ignored = new Set(ignoredWorkflowNames);
  const grouped = new Map();

  for (const raw of runs) {
    const run = runIdentity(raw);
    if (ignored.has(run.name)) continue;
    const bucket = grouped.get(run.workflow_id) || [];
    bucket.push(run);
    grouped.set(run.workflow_id, bucket);
  }

  const states = [];
  for (const bucket of grouped.values()) {
    bucket.sort((left, right) => {
      const byTime = timestamp(right.created_at, "run_created_at") - timestamp(left.created_at, "run_created_at");
      return byTime || right.id - left.id;
    });
    const latest = bucket[0];
    const ageMs = nowMs - timestamp(latest.updated_at || latest.created_at, "run_updated_at");
    if (ageMs < -5 * 60_000) fail("run_timestamp_in_future");

    if (decommissionedIds.has(latest.workflow_id) || decommissionedNames.has(latest.name)) {
      states.push({
        state: "DECOMMISSIONED",
        reason: decommissionedIds.has(latest.workflow_id)
          ? "workflow path is absent from the current default branch"
          : "workflow is explicitly retired or quarantined",
        workflow_id: latest.workflow_id,
        workflow_name: latest.name,
        latest_run_id: latest.id,
        latest_run_url: latest.html_url,
        observed_at: latest.updated_at || latest.created_at,
      });
      continue;
    }

    if (latest.status !== "completed") {
      const createdAgeMs = nowMs - timestamp(latest.created_at, "run_created_at");
      states.push(createdAgeMs >= staleMs
        ? activeState(latest, "stale_run", "latest run exceeded the bounded stale threshold")
        : {
            state: "UNKNOWN",
            reason: "latest run is still within its execution window",
            workflow_id: latest.workflow_id,
            workflow_name: latest.name,
            latest_run_id: latest.id,
            latest_run_url: latest.html_url,
            observed_at: latest.updated_at || latest.created_at,
          });
      continue;
    }

    if (FAILURE_CONCLUSIONS.has(latest.conclusion)) {
      states.push(ageMs >= graceMs
        ? activeState(latest, `workflow_${latest.conclusion}`, `latest terminal conclusion is ${latest.conclusion}`)
        : {
            state: "UNKNOWN",
            reason: "terminal failure is inside the anti-race grace window",
            workflow_id: latest.workflow_id,
            workflow_name: latest.name,
            latest_run_id: latest.id,
            latest_run_url: latest.html_url,
            observed_at: latest.updated_at || latest.created_at,
          });
      continue;
    }

    if (latest.conclusion === "cancelled") {
      states.push({
        state: expectedCancelled.has(latest.name) ? "EXPECTED_CANCEL" : "UNKNOWN",
        reason: expectedCancelled.has(latest.name)
          ? "workflow is allowlisted for concurrency replacement"
          : "cancellation is not allowlisted as expected",
        workflow_id: latest.workflow_id,
        workflow_name: latest.name,
        latest_run_id: latest.id,
        latest_run_url: latest.html_url,
        observed_at: latest.updated_at || latest.created_at,
      });
      continue;
    }

    if (HEALTHY_CONCLUSIONS.has(latest.conclusion)) {
      const previousFailure = bucket.slice(1).find((run) => FAILURE_CONCLUSIONS.has(run.conclusion));
      states.push({
        state: previousFailure ? "RECOVERED_INCIDENT" : "HEALTHY",
        reason: previousFailure ? "a newer terminal success supersedes a prior failure" : "latest terminal run is healthy",
        workflow_id: latest.workflow_id,
        workflow_name: latest.name,
        latest_run_id: latest.id,
        latest_run_url: latest.html_url,
        observed_at: latest.updated_at || latest.created_at,
      });
      continue;
    }

    states.push({
      state: "UNKNOWN",
      reason: "unrecognized terminal conclusion",
      workflow_id: latest.workflow_id,
      workflow_name: latest.name,
      latest_run_id: latest.id,
      latest_run_url: latest.html_url,
      observed_at: latest.updated_at || latest.created_at,
    });
  }

  return states.sort((left, right) => left.workflow_id - right.workflow_id);
}

export function planIncidentActions(states, openIncidents = []) {
  if (!Array.isArray(states) || !Array.isArray(openIncidents)) fail("invalid_incident_plan_input");
  const actions = [];
  for (const state of states) {
    const matchingWorkflow = openIncidents.filter((item) => item.workflow_id === state.workflow_id);
    if (state.state === "ACTIVE_FAILURE") {
      const exact = matchingWorkflow.find((item) => item.fingerprint === state.fingerprint);
      if (!exact) {
        actions.push({ action: "CREATE", state, occurrences: 1 });
      } else if (exact.latest_run_id !== state.latest_run_id) {
        actions.push({
          action: "UPDATE",
          issue_number: exact.issue_number,
          state,
          occurrences: (exact.occurrences || 1) + 1,
          first_seen_at: exact.first_seen_at,
        });
      }
      for (const stale of matchingWorkflow.filter((item) => item.fingerprint !== state.fingerprint)) {
        actions.push({ action: "CLOSE", issue_number: stale.issue_number, state, resolution: "SUPERSEDED" });
      }
      continue;
    }
    if (["HEALTHY", "RECOVERED_INCIDENT", "DECOMMISSIONED"].includes(state.state)) {
      for (const incident of matchingWorkflow) {
        actions.push({
          action: "CLOSE",
          issue_number: incident.issue_number,
          state,
          resolution: state.state === "DECOMMISSIONED" ? "DECOMMISSIONED" : "RECOVERED",
        });
      }
    }
  }
  return actions.sort((left, right) => {
    const leftIssue = left.issue_number || Number.MAX_SAFE_INTEGER;
    const rightIssue = right.issue_number || Number.MAX_SAFE_INTEGER;
    return leftIssue - rightIssue || left.state.workflow_id - right.state.workflow_id;
  });
}

function safeWorkflowName(name) {
  return boundedString(name, "workflow_name", 200).replace(/[\r\n`<>]/g, " ").replace(/\s+/g, " ").trim();
}

export function renderIncidentTitle(state) {
  return `[ANOMALY] GitHub workflow: ${safeWorkflowName(state.workflow_name)}`.slice(0, 240);
}

export function renderIncidentBody(state, {
  occurrences = 1,
  firstSeenAt = state.observed_at,
  resolution = null,
} = {}) {
  if (state.state !== "ACTIVE_FAILURE" && !resolution) fail("incident_body_requires_active_or_resolution");
  const marker = `<!-- jarvis-anomaly-sentinel:v1 workflow_id=${state.workflow_id} fingerprint=${state.fingerprint || "resolved"} -->`;
  return [
    marker,
    "**RUNTIME ANOMALY SENTINEL**",
    `- state: **${resolution ? "RESOLVED" : "ACTIVE_FAILURE"}**`,
    `- workflow: \`${safeWorkflowName(state.workflow_name)}\``,
    `- incident_class: \`${state.incident_class || "workflow_recovery"}\``,
    `- fingerprint: \`${state.fingerprint || "n/a"}\``,
    `- occurrences: ${occurrences}`,
    `- first_seen_utc: ${firstSeenAt}`,
    `- last_seen_utc: ${state.observed_at}`,
    `- latest_run_id: ${state.latest_run_id}`,
    `- latest_run: ${state.latest_run_url}`,
    `- reason: ${state.reason}`,
    resolution ? `- resolution: ${resolution}` : null,
    "- data_boundary: public GitHub runtime metadata only",
    "- mailbox_or_private_content_published: false",
  ].filter(Boolean).join("\n");
}

export function parseIncidentIssue(issue) {
  const match = (issue?.body || "").match(/<!-- jarvis-anomaly-sentinel:v1 workflow_id=(\d+) fingerprint=([^ ]+) -->/);
  if (!match || !Number.isInteger(issue?.number)) return null;
  const occurrences = Number((issue.body.match(/- occurrences: (\d+)/) || [])[1] || 1);
  const latestRunId = Number((issue.body.match(/- latest_run_id: (\d+)/) || [])[1] || 0);
  const firstSeenAt = (issue.body.match(/- first_seen_utc: ([^\n]+)/) || [])[1] || null;
  return {
    issue_number: issue.number,
    workflow_id: Number(match[1]),
    fingerprint: match[2],
    occurrences,
    latest_run_id: latestRunId,
    first_seen_at: firstSeenAt,
  };
}

export { FAILURE_CONCLUSIONS, HEALTHY_CONCLUSIONS };
