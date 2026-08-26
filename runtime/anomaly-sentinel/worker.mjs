import {
  classifyWorkflowRuns,
  parseIncidentIssue,
  planIncidentActions,
  renderIncidentBody,
  renderIncidentTitle,
} from "./sentinel.mjs";

const repository = requiredEnv("GITHUB_REPOSITORY");
const token = requiredEnv("GITHUB_TOKEN");
const runId = requiredEnv("GITHUB_RUN_ID");
const expectedCancelledWorkflows = (process.env.EXPECTED_CANCEL_WORKFLOWS || "Kyiv V3 public collector")
  .split(",").map((value) => value.trim()).filter(Boolean);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

async function githubRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-runtime-anomaly-sentinel",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_api_${response.status}:${text.slice(0, 200)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function paginated(path, key, maxPages = 10) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await githubRequest(`${path}${separator}per_page=100&page=${page}`);
    const pageItems = Array.isArray(response) ? response : response?.[key];
    if (!Array.isArray(pageItems)) throw new Error(`invalid_${key}_response`);
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
  throw new Error(`${key}_pagination_incomplete`);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadRecentRuns() {
  const workflows = await paginated(`/repos/${repository}/actions/workflows`, "workflows");
  const enabled = workflows.filter((workflow) => workflow.state === "active");
  const runGroups = await mapLimit(enabled, 5, async (workflow) => {
    const response = await githubRequest(
      `/repos/${repository}/actions/workflows/${workflow.id}/runs?per_page=10&exclude_pull_requests=false`,
    );
    return (response?.workflow_runs || []).map((run) => ({ ...run, name: workflow.name }));
  });
  return runGroups.flat();
}

async function loadOpenIncidents() {
  const issues = await paginated(`/repos/${repository}/issues?state=open`, "items");
  return issues
    .filter((issue) => !issue.pull_request && issue.title?.startsWith("[ANOMALY]"))
    .map(parseIncidentIssue)
    .filter(Boolean);
}

async function executeAction(action) {
  const state = action.state;
  if (action.action === "CREATE") {
    const created = await githubRequest(`/repos/${repository}/issues`, {
      method: "POST",
      body: {
        title: renderIncidentTitle(state),
        body: renderIncidentBody(state, { occurrences: action.occurrences }),
      },
    });
    return { action: "CREATE", issue_number: created.number, workflow_id: state.workflow_id };
  }
  if (action.action === "UPDATE") {
    await githubRequest(`/repos/${repository}/issues/${action.issue_number}`, {
      method: "PATCH",
      body: {
        body: renderIncidentBody(state, {
          occurrences: action.occurrences,
          firstSeenAt: action.first_seen_at,
        }),
      },
    });
    return { action: "UPDATE", issue_number: action.issue_number, workflow_id: state.workflow_id };
  }
  if (action.action === "CLOSE") {
    const issue = await githubRequest(`/repos/${repository}/issues/${action.issue_number}`);
    const parsed = parseIncidentIssue(issue);
    await githubRequest(`/repos/${repository}/issues/${action.issue_number}`, {
      method: "PATCH",
      body: {
        state: "closed",
        state_reason: "completed",
        body: renderIncidentBody(state, {
          occurrences: parsed?.occurrences || 1,
          firstSeenAt: parsed?.first_seen_at || state.observed_at,
          resolution: action.resolution,
        }),
      },
    });
    return { action: "CLOSE", issue_number: action.issue_number, workflow_id: state.workflow_id };
  }
  throw new Error("unknown_incident_action");
}

async function main() {
  const runs = await loadRecentRuns();
  const states = classifyWorkflowRuns(runs, {
    expectedCancelledWorkflows,
    ignoredWorkflowNames: ["Runtime Anomaly Sentinel", "Runtime Anomaly Sentinel CI"],
  });
  const openIncidents = await loadOpenIncidents();
  const plan = planIncidentActions(states, openIncidents);
  const executed = [];
  for (const action of plan) executed.push(await executeAction(action));

  const counts = Object.fromEntries(
    ["ACTIVE_FAILURE", "RECOVERED_INCIDENT", "EXPECTED_CANCEL", "HEALTHY", "UNKNOWN"]
      .map((state) => [state, states.filter((item) => item.state === state).length]),
  );
  console.log(`ANOMALY_SENTINEL_READBACK ${JSON.stringify({
    schema_version: 1,
    run_id: runId,
    workflows_observed: states.length,
    state_counts: counts,
    actions: executed,
    public_metadata_only: true,
    mailbox_content_read: false,
  })}`);
}

await main();
