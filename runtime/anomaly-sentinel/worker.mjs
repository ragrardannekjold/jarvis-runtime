import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  classifyWorkflowHealth,
  parseIncidentIssue,
  planIncidentActions,
  renderIncidentBody,
  renderIncidentTitle,
  sha256,
  validateLivenessContracts,
} from "./sentinel.mjs";

const CONTRACT_URL = new URL("./liveness-contracts.json", import.meta.url);
const GITHUB_API_REQUEST_BUDGET = 100;
const MAX_SCHEDULED_UPSERTS_PER_CYCLE = 0;
const READBACK_STATES = [
  "ACTIVE_FAILURE", "STALE_SUCCESS", "RECOVERY_PENDING", "UNKNOWN", "RUNNING",
  "EXPECTED_CANCEL", "HEALTHY", "RECOVERED_INCIDENT", "FRESH", "DECOMMISSIONED",
];

function fail(code) { throw new Error(code); }

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail("missing_" + name.toLowerCase());
  return value;
}

function safeSha(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) fail("invalid_" + field);
  return value;
}

function parseContractManifest(text) {
  let manifest;
  try { manifest = JSON.parse(text); } catch { fail("invalid_liveness_contract_json"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("invalid_liveness_contract_manifest");
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["baseline_ref", "contracts", "incident_closure_mode", "schema_version"])) fail("invalid_liveness_contract_manifest_fields");
  if (manifest.schema_version !== 2) fail("unsupported_liveness_contract_schema");
  if (manifest.incident_closure_mode !== "quarantine") fail("incident_closure_authority_not_verified");
  safeSha(manifest.baseline_ref, "baseline_ref");
  const contracts = validateLivenessContracts(manifest.contracts);
  return { manifest, contracts, contract_digest: sha256(text) };
}

export function createGithubRequest({ token, fetchImpl = fetch }) {
  if (!token) fail("missing_github_token");
  let requestCount = 0;
  const requestBudget = GITHUB_API_REQUEST_BUDGET;
  return async function githubRequest(path, { method = "GET", body } = {}) {
    requestCount += 1;
    if (requestCount > requestBudget) fail("github_api_request_budget_exceeded");
    const response = await fetchImpl("https://api.github.com" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis-runtime-anomaly-sentinel",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error("github_api_" + response.status + ":" + text.slice(0, 200));
    }
    if (response.status === 204) return null;
    return response.json();
  };
}

async function paginated(request, path, key, maxPages = 10) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await request(path + separator + "per_page=100&page=" + page);
    const pageItems = Array.isArray(response) ? response : response?.[key];
    if (!Array.isArray(pageItems)) fail("invalid_" + key + "_response");
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
  fail(key + "_pagination_incomplete");
}

async function paginatedWorkflowRuns(request, path, maxPages = 10) {
  const runs = [];
  const identities = new Set();
  let expectedTotal = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await request(path + separator + "per_page=100&page=" + page);
    const pageRuns = response?.workflow_runs;
    if (!Array.isArray(pageRuns)) fail("invalid_workflow_runs_response");
    if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0) fail("invalid_workflow_runs_total_count");
    if (expectedTotal === null) expectedTotal = response.total_count;
    if (response.total_count !== expectedTotal) fail("workflow_runs_total_count_drift");
    if (expectedTotal >= 1000) fail("workflow_run_search_cap_reached");
    for (const run of pageRuns) {
      const identity = String(run?.id);
      if (identities.has(identity)) fail("workflow_runs_page_overlap");
      identities.add(identity);
      runs.push(run);
    }
    if (pageRuns.length < 100) {
      if (runs.length !== expectedTotal) fail("workflow_runs_inventory_drift");
      return runs;
    }
  }
  fail("workflow_runs_pagination_incomplete");
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

export async function assertPinnedHead({ request, repository, defaultBranch, pinnedCommit }) {
  const ref = await request("/repos/" + repository + "/git/ref/heads/" + encodeURIComponent(defaultBranch));
  if (ref?.object?.sha !== pinnedCommit) fail("default_branch_head_drift");
  return ref.object.sha;
}

export async function assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit }) {
  const repositoryState = await request("/repos/" + repository);
  if (repositoryState?.default_branch !== defaultBranch) fail("repository_default_branch_drift");
  return assertPinnedHead({ request, repository, defaultBranch, pinnedCommit });
}

function enrichRuns(runs, workflow) {
  if (!Array.isArray(runs)) fail("invalid_workflow_runs_response");
  const trusted = [];
  for (const run of runs) {
    if (run.workflow_id !== workflow.workflow_id) fail("workflow_run_api_identity_mismatch");
    safeSha(run.head_sha, "run_head_sha");
    if (
      run.head_branch !== workflow.default_branch
      || run.head_repository?.full_name !== workflow.repository
      || run.event === "pull_request"
      || run.event === "pull_request_target"
    ) continue;
    trusted.push({
      id: run.id,
      run_attempt: run.run_attempt || 1,
      workflow_id: workflow.workflow_id,
      workflow_name: workflow.workflow_name,
      workflow_path: workflow.workflow_path,
      workflow_url: workflow.workflow_url,
      head_sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      created_at: run.created_at,
      run_started_at: run.run_started_at || run.created_at,
      updated_at: run.updated_at,
      html_url: run.html_url,
    });
  }
  return trusted;
}

function executionRevisionFirst(left, right) {
  const byStarted = Date.parse(right.run_started_at) - Date.parse(left.run_started_at);
  const byUpdated = Date.parse(right.updated_at || right.run_started_at)
    - Date.parse(left.updated_at || left.run_started_at);
  const byCreated = Date.parse(right.created_at) - Date.parse(left.created_at);
  return byStarted || byUpdated || byCreated || right.id - left.id || (right.run_attempt || 1) - (left.run_attempt || 1);
}

function scheduledPulseFirst(left, right) {
  const byCreated = Date.parse(right.created_at) - Date.parse(left.created_at);
  return byCreated || right.id - left.id || (right.run_attempt || 1) - (left.run_attempt || 1);
}

function encodedWorkflowPath(workflowPath) {
  return workflowPath.split("/").map(encodeURIComponent).join("/");
}

async function workflowBlobAtRun({ request, repository, workflowPath, headSha, cache = null }) {
  safeSha(headSha, "run_head_sha");
  const key = workflowPath + "@" + headSha;
  if (cache?.has(key)) return cache.get(key);
  const source = await request(
    "/repos/" + repository + "/contents/" + encodedWorkflowPath(workflowPath)
      + "?ref=" + encodeURIComponent(headSha),
  );
  if (source?.type !== "file" || source?.path !== workflowPath) fail("run_workflow_source_readback_mismatch");
  const sha = safeSha(source.sha, "run_workflow_blob_sha");
  cache?.set(key, sha);
  return sha;
}

async function bindRunsToSource({ request, repository, workflow, runs, cache }) {
  const bound = [];
  for (const run of runs) {
    const sha = await workflowBlobAtRun({
      request,
      repository,
      workflowPath: workflow.workflow_path,
      headSha: run.head_sha,
      cache,
    });
    bound.push({ ...run, workflow_blob_sha_at_run: sha });
  }
  return bound;
}

export async function collectSnapshot({
  request,
  repository,
  defaultBranch,
  pinnedCommit,
  contractText,
}) {
  safeSha(pinnedCommit, "pinned_commit");
  await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
  const { contracts, contract_digest: contractDigest } = parseContractManifest(contractText);
  const commit = await request("/repos/" + repository + "/git/commits/" + pinnedCommit);
  if (commit?.sha !== pinnedCommit) fail("pinned_commit_readback_mismatch");
  const treeSha = safeSha(commit?.tree?.sha, "pinned_tree_sha");
  const tree = await request("/repos/" + repository + "/git/trees/" + treeSha + "?recursive=1");
  if (tree?.truncated || !Array.isArray(tree?.tree)) fail("pinned_tree_incomplete");
  const workflowEntries = tree.tree.filter(
    (entry) => entry.type === "blob" && /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(entry.path),
  );
  const treeByPath = new Map();
  for (const entry of workflowEntries) {
    if (treeByPath.has(entry.path)) fail("duplicate_workflow_tree_path");
    treeByPath.set(entry.path, entry);
  }
  const contractPaths = contracts.map((item) => item.workflow_path).sort();
  const treePaths = [...treeByPath.keys()].sort();
  if (JSON.stringify(contractPaths) !== JSON.stringify(treePaths)) fail("contract_tree_path_mismatch");

  const apiWorkflows = await paginated(request, "/repos/" + repository + "/actions/workflows", "workflows");
  const apiByPath = new Map();
  const apiIds = new Set();
  for (const workflow of apiWorkflows) {
    if (apiByPath.has(workflow.path)) fail("duplicate_api_workflow_path");
    if (apiIds.has(workflow.id)) fail("duplicate_api_workflow_id");
    apiByPath.set(workflow.path, workflow);
    apiIds.add(workflow.id);
  }
  const unexpectedActive = apiWorkflows.filter((item) => item.state === "active" && !treeByPath.has(item.path));
  if (unexpectedActive.length > 0) fail("active_api_workflow_missing_from_tree");

  const workflowInventory = contracts.map((contract) => {
    const source = treeByPath.get(contract.workflow_path);
    const workflow = apiByPath.get(contract.workflow_path);
    if (!workflow) fail("contract_workflow_missing_from_api_inventory");
    return {
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      workflow_path: workflow.path,
      workflow_url: workflow.html_url,
      workflow_state: workflow.state,
      workflow_blob_sha: source.sha,
      repository,
      default_branch: defaultBranch,
    };
  });

  const contractByPath = new Map(contracts.map((item) => [item.workflow_path, item]));
  const observedWorkflows = workflowInventory.filter((identity) => {
    const mode = contractByPath.get(identity.workflow_path).mode;
    return mode === "scheduled" || mode === "event_driven";
  });
  const runSourceCache = new Map();
  const allGroups = await mapLimit(observedWorkflows, 5, async (workflow) => {
    const response = await request(
      "/repos/" + repository + "/actions/workflows/" + workflow.workflow_id
      + "/runs?branch=" + encodeURIComponent(defaultBranch) + "&per_page=100",
    );
    if (!Array.isArray(response?.workflow_runs)) fail("invalid_workflow_runs_response");
    const rawRuns = response.workflow_runs;
    const runs = enrichRuns(rawRuns, workflow).sort(executionRevisionFirst).slice(0, 2);
    return bindRunsToSource({ request, repository, workflow, runs, cache: runSourceCache });
  });
  const scheduledWorkflows = observedWorkflows.filter(
    (identity) => contractByPath.get(identity.workflow_path).mode === "scheduled",
  );
  const scheduledGroups = await mapLimit(scheduledWorkflows, 5, async (workflow) => {
    const contract = contractByPath.get(workflow.workflow_path);
    const quorumWindow = contract.freshness_ttl_ms
      + (contract.recovery_min_successes - 1) * (contract.cadence_ms + contract.grace_ms);
    const oldestRequired = new Date(Date.now() - quorumWindow).toISOString();
    const rawRuns = await paginatedWorkflowRuns(request,
      "/repos/" + repository + "/actions/workflows/" + workflow.workflow_id
      + "/runs?branch=" + encodeURIComponent(defaultBranch)
      + "&event=schedule&created=" + encodeURIComponent(">=" + oldestRequired),
    );
    const runs = enrichRuns(rawRuns, workflow)
      .sort(scheduledPulseFirst).slice(0, contract.recovery_min_successes);
    if (runs.some((run) => run.event !== "schedule")) fail("schedule_query_returned_non_schedule_run");
    return bindRunsToSource({ request, repository, workflow, runs, cache: runSourceCache });
  });
  const workflowSourceDigest = sha256(workflowEntries
    .slice().sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => entry.path + "=" + entry.sha).join("\n"));
  return {
    pinned_commit: pinnedCommit,
    pinned_tree_sha: treeSha,
    contract_digest: contractDigest,
    workflow_source_digest: workflowSourceDigest,
    liveness_contracts: contracts,
    workflow_inventory: workflowInventory,
    all_event_runs: allGroups.flat(),
    scheduled_runs: scheduledGroups.flat(),
    execution_history_complete: false,
    incident_closure_mode: "quarantine",
  };
}

async function loadOpenIncidents({ request, repository }) {
  const issues = await request(
    "/repos/" + repository + "/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100",
  );
  if (!Array.isArray(issues)) fail("invalid_incident_inventory_response");
  if (issues.length >= 100) fail("incident_inventory_unbounded");
  return issues
    .filter((issue) => !issue.pull_request && issue.title?.startsWith("[ANOMALY]"))
    .map((issue) => parseIncidentIssue(issue, { repository }))
    .filter(Boolean);
}

function sameCanonicalIncident(left, right) {
  return left && right && left.legacy === false && right.legacy === false
    && left.fingerprint === right.fingerprint
    && left.evidence_digest === right.evidence_digest
    && left.axis === right.axis
    && left.workflow_id === right.workflow_id
    && left.workflow_name === right.workflow_name
    && left.workflow_path === right.workflow_path
    && left.incident_class === right.incident_class
    && left.current_subtype === right.current_subtype
    && left.displayed_state === right.displayed_state
    && left.displayed_reason === right.displayed_reason
    && left.occurrences === right.occurrences
    && left.latest_run_id === right.latest_run_id
    && left.latest_run_url === right.latest_run_url
    && left.run_attempt === right.run_attempt
    && left.first_seen_at === right.first_seen_at
    && left.last_seen_at === right.last_seen_at
    && left.evidence_at === right.evidence_at
    && (left.evidence_revision_at || left.evidence_at) === (right.evidence_revision_at || right.evidence_at)
    && left.issue_state === "open";
}

async function verifyIssue({ request, repository, issueNumber, expectedFingerprint, expectedDigest = null }) {
  const issue = await request("/repos/" + repository + "/issues/" + issueNumber);
  const parsed = parseIncidentIssue(issue, { repository });
  if (!parsed || parsed.legacy || parsed.issue_state !== "open" || parsed.fingerprint !== expectedFingerprint) fail("incident_issue_readback_mismatch");
  if (expectedDigest !== null && parsed.evidence_digest !== expectedDigest) fail("incident_issue_evidence_mismatch");
  return { issue, parsed };
}

function evidenceQueryPath(signal, repository, defaultBranch, nowMs) {
  const eventFilter = signal.axis === "scheduled_liveness" ? "&event=schedule" : "";
  const createdFilter = signal.axis === "scheduled_liveness" && Number.isSafeInteger(signal.cadence_ms)
    ? "&created=" + encodeURIComponent(">=" + new Date(
      nowMs - (
        signal.freshness_ttl_ms
        + (signal.required_healthy_pulses - 1) * (signal.cadence_ms + signal.grace_ms)
      ),
    ).toISOString())
    : "";
  return "/repos/" + repository + "/actions/workflows/" + signal.workflow_id
    + "/runs?branch=" + encodeURIComponent(defaultBranch)
    + eventFilter + createdFilter;
}

async function verifyWorkflowAuthority({ signal, request, repository, defaultBranch }) {
  const workflow = await request(
    "/repos/" + repository + "/actions/workflows/" + signal.workflow_id,
  );
  if (
    workflow?.id !== signal.workflow_id
    || workflow?.name !== signal.workflow_name
    || workflow?.path !== signal.workflow_path
  ) fail("workflow_live_identity_or_state_drift");
  if (signal.incident_class === "workflow_disabled") {
    if (workflow.state === "active" || workflow.state !== signal.workflow_state) fail("workflow_disabled_not_reproducible");
  } else if (workflow.state !== "active") {
    fail("workflow_live_identity_or_state_drift");
  }
  return {
    workflow_id: workflow.id,
    workflow_name: workflow.name,
    workflow_path: workflow.path,
    workflow_url: workflow.html_url,
    workflow_state: workflow.state,
    workflow_blob_sha: signal.workflow_blob_sha,
    repository,
    default_branch: defaultBranch,
  };
}

function assertRunMatchesSignal(run, signal) {
  const evidenceAt = signal.axis === "execution_health" ? run?.run_started_at : run?.created_at;
  if (
    !run
    || run.id !== signal.latest_run_id
    || (run.run_attempt || 1) !== signal.run_attempt
    || run.event !== signal.run_event
    || run.status !== signal.run_status
    || run.conclusion !== signal.run_conclusion
    || evidenceAt !== signal.evidence_at
    || run.head_sha !== signal.latest_head_sha
    || (run.updated_at || run.created_at) !== signal.evidence_revision_at
  ) fail("signal_evidence_drift");
}

async function verifySignalEvidence({ signal, request, repository, defaultBranch, clock, requireQuorum = false }) {
  if (signal.decommissioned) return;
  const nowMs = clock().getTime();
  if (!Number.isFinite(nowMs)) fail("invalid_evidence_clock");
  const workflow = await verifyWorkflowAuthority({ signal, request, repository, defaultBranch });
  if (signal.incident_class === "workflow_disabled") return;
  let rawRuns;
  if (signal.axis === "scheduled_liveness") {
    rawRuns = await paginatedWorkflowRuns(
      request,
      evidenceQueryPath(signal, repository, defaultBranch, nowMs),
    );
  } else {
    const response = await request(evidenceQueryPath(signal, repository, defaultBranch, nowMs) + "&per_page=100");
    if (!Array.isArray(response?.workflow_runs)) fail("invalid_evidence_runs_response");
    rawRuns = response.workflow_runs;
  }
  const runs = enrichRuns(rawRuns, workflow).sort(
    signal.axis === "execution_health" ? executionRevisionFirst : scheduledPulseFirst,
  );
  if (signal.latest_run_id === 0) {
    if (runs.length !== 0) fail("signal_evidence_drift");
    return;
  }
  assertRunMatchesSignal(runs[0], signal);
  const latestCreatedAt = Date.parse(runs[0].created_at);
  const latestStartedAt = Date.parse(runs[0].run_started_at);
  const latestUpdatedAt = Date.parse(runs[0].updated_at || runs[0].created_at);
  if (
    !Number.isFinite(nowMs)
    || !Number.isFinite(latestCreatedAt)
    || !Number.isFinite(latestStartedAt)
    || !Number.isFinite(latestUpdatedAt)
    || latestCreatedAt > nowMs
    || latestStartedAt > nowMs
    || latestUpdatedAt > nowMs
  ) fail("signal_evidence_clock_skew");
  const latestWorkflowBlob = await workflowBlobAtRun({
    request,
    repository,
    workflowPath: signal.workflow_path,
    headSha: runs[0].head_sha,
  });
  if (latestWorkflowBlob !== signal.latest_workflow_blob_sha) fail("signal_workflow_source_drift");
  if (signal.incident_class === "workflow_source_mismatch") {
    if (latestWorkflowBlob === signal.workflow_blob_sha) fail("signal_source_mismatch_not_reproducible");
  } else if (latestWorkflowBlob !== signal.workflow_blob_sha) {
    fail("signal_current_workflow_source_not_executed");
  }
  if (!requireQuorum || signal.axis !== "scheduled_liveness") return;
  if (
    !Array.isArray(signal.recovery_pulses)
    || signal.recovery_pulses.length < signal.required_healthy_pulses
    || !Number.isSafeInteger(signal.freshness_ttl_ms)
    || !Number.isSafeInteger(signal.cadence_ms)
    || !Number.isSafeInteger(signal.grace_ms)
  ) fail("close_quorum_missing");
  const latestPulseCreatedAt = Date.parse(signal.recovery_pulses[0].created_at);
  if (!Number.isFinite(latestPulseCreatedAt) || nowMs - latestPulseCreatedAt >= signal.freshness_ttl_ms) {
    fail("close_quorum_stale");
  }
  const currentById = new Map(runs.map((run) => [run.id, run]));
  const minimumGap = Math.max(60_000, Math.floor(signal.cadence_ms / 2), signal.cadence_ms - signal.grace_ms);
  const maximumGap = signal.cadence_ms + signal.grace_ms;
  let newerCreatedAt = null;
  for (const pulse of signal.recovery_pulses.slice(0, signal.required_healthy_pulses)) {
    const current = currentById.get(pulse.id);
    if (
      !current
      || (current.run_attempt || 1) !== pulse.run_attempt
      || current.event !== "schedule"
      || current.status !== "completed"
      || current.conclusion !== "success"
      || current.created_at !== pulse.created_at
      || current.head_sha !== pulse.head_sha
      || current.updated_at !== pulse.updated_at
    ) fail("close_quorum_drift");
    const createdAt = Date.parse(current.created_at);
    const startedAt = Date.parse(current.run_started_at);
    const updatedAt = Date.parse(current.updated_at || current.created_at);
    if (
      !Number.isFinite(createdAt)
      || !Number.isFinite(startedAt)
      || !Number.isFinite(updatedAt)
      || createdAt > nowMs
      || startedAt > nowMs
      || updatedAt > nowMs
    ) fail("close_quorum_clock_skew");
    const pulseWorkflowBlob = await workflowBlobAtRun({
      request,
      repository,
      workflowPath: signal.workflow_path,
      headSha: current.head_sha,
    });
    if (
      pulseWorkflowBlob !== pulse.workflow_blob_sha_at_run
      || pulseWorkflowBlob !== signal.workflow_blob_sha
    ) fail("close_quorum_source_drift");
    if (newerCreatedAt !== null) {
      const gap = newerCreatedAt - createdAt;
      if (gap < minimumGap || gap > maximumGap) fail("close_quorum_gap_drift");
    }
    newerCreatedAt = createdAt;
  }
}

async function executeUpsert({ action, request, repository, defaultBranch, pinnedCommit, clock }) {
  const signal = action.signal;
  await verifySignalEvidence({ signal, request, repository, defaultBranch, clock });
  await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
  if (action.action === "CREATE") {
    const liveIncidents = await loadOpenIncidents({ request, repository });
    if (liveIncidents.some((incident) => incident.fingerprint === signal.fingerprint)) {
      fail("incident_created_concurrently");
    }
    let created = null;
    try {
      created = await request("/repos/" + repository + "/issues", {
        method: "POST",
        body: {
          title: renderIncidentTitle(signal),
          body: renderIncidentBody(signal, { occurrences: action.occurrences }),
        },
      });
      if (!Number.isInteger(created?.number)) fail("incident_create_missing_number");
      const { parsed } = await verifyIssue({
        request,
        repository,
        issueNumber: created.number,
        expectedFingerprint: signal.fingerprint,
        expectedDigest: signal.evidence_digest,
      });
      await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
      await verifySignalEvidence({ signal, request, repository, defaultBranch, clock });
      return { action: "CREATE", issue_number: created.number, fingerprint: parsed.fingerprint };
    } catch (error) {
      let issueNumber = Number.isInteger(created?.number) ? created.number : null;
      if (issueNumber === null) {
        const candidates = (await loadOpenIncidents({ request, repository }))
          .filter((incident) => incident.fingerprint === signal.fingerprint);
        if (candidates.length > 1) fail("duplicate_canonical_incident");
        issueNumber = candidates[0]?.issue_number ?? null;
      }
      if (issueNumber === null) throw error;
      const observedAt = clock().toISOString();
      const uncertainty = {
        ...signal,
        phase: "HOLD",
        state: "UNKNOWN",
        incident_class: "post_write_evidence_drift",
        reason: "Actions evidence or source authority changed during issue creation; incident remains open for manual reconciliation",
        observed_at: observedAt,
        evidence_digest: sha256(signal.fingerprint + "\0post_write_evidence_drift\0" + observedAt),
      };
      await request("/repos/" + repository + "/issues/" + issueNumber, {
        method: "PATCH",
        body: {
          state: "open",
          title: renderIncidentTitle(uncertainty),
          body: renderIncidentBody(uncertainty, { occurrences: action.occurrences }),
        },
      });
      await verifyIssue({
        request,
        repository,
        issueNumber,
        expectedFingerprint: signal.fingerprint,
        expectedDigest: uncertainty.evidence_digest,
      });
      throw new Error("incident_create_compensated:" + error.message);
    }
  }
  if (action.action === "UPDATE") {
    const live = await verifyIssue({
      request,
      repository,
      issueNumber: action.issue_number,
      expectedFingerprint: signal.fingerprint,
    });
    if (!sameCanonicalIncident(live.parsed, action.existing_incident)) fail("incident_changed_before_update");
    try {
      await request("/repos/" + repository + "/issues/" + action.issue_number, {
        method: "PATCH",
        body: {
          body: renderIncidentBody(signal, {
            occurrences: action.occurrences,
            firstSeenAt: action.repair_untrusted_provenance
              ? signal.observed_at
              : live.parsed.first_seen_at,
            existingIncident: action.repair_untrusted_provenance ? null : live.parsed,
          }),
        },
      });
      await verifyIssue({
        request,
        repository,
        issueNumber: action.issue_number,
        expectedFingerprint: signal.fingerprint,
        expectedDigest: signal.evidence_digest,
      });
      await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
      await verifySignalEvidence({ signal, request, repository, defaultBranch, clock });
      return { action: "UPDATE", issue_number: action.issue_number, fingerprint: signal.fingerprint };
    } catch (error) {
      try {
        await restoreOpenIncident({ request, repository, live });
      } catch (restoreError) {
        throw new Error("incident_update_compensation_failed:" + error.message + ":" + restoreError.message);
      }
      throw new Error("incident_update_compensated:" + error.message);
    }
  }
  fail("invalid_upsert_action");
}

async function restoreOpenIncident({ request, repository, live }) {
  await request("/repos/" + repository + "/issues/" + live.issue.number, {
    method: "PATCH",
    body: { state: "open", title: live.issue.title, body: live.issue.body },
  });
  const restored = await request("/repos/" + repository + "/issues/" + live.issue.number);
  if (
    restored?.state !== "open"
    || restored.title !== live.issue.title
    || restored.body !== live.issue.body
  ) fail("incident_close_compensation_readback_mismatch");
}

async function executeClose({ action, request, repository, defaultBranch, pinnedCommit, clock }) {
  await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
  await verifySignalEvidence({
    signal: action.signal,
    request,
    repository,
    defaultBranch,
    clock,
    requireQuorum: action.signal.axis === "scheduled_liveness" && !action.signal.decommissioned,
  });
  const live = await verifyIssue({
    request,
    repository,
    issueNumber: action.issue_number,
    expectedFingerprint: action.signal.fingerprint,
  });
  if (!sameCanonicalIncident(live.parsed, action.existing_incident)) fail("incident_changed_before_close");
  await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
  await verifySignalEvidence({
    signal: action.signal,
    request,
    repository,
    defaultBranch,
    clock,
    requireQuorum: action.signal.axis === "scheduled_liveness" && !action.signal.decommissioned,
  });
  try {
    await request("/repos/" + repository + "/issues/" + action.issue_number, {
      method: "PATCH",
      body: {
        state: "closed",
        state_reason: "completed",
        body: renderIncidentBody(action.signal, {
          occurrences: live.parsed.occurrences,
          firstSeenAt: live.parsed.first_seen_at,
          resolution: action.resolution,
          existingIncident: live.parsed,
        }),
      },
    });
    await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
    await verifySignalEvidence({
      signal: action.signal,
      request,
      repository,
      defaultBranch,
      clock,
      requireQuorum: action.signal.axis === "scheduled_liveness" && !action.signal.decommissioned,
    });
    const closed = await request("/repos/" + repository + "/issues/" + action.issue_number);
    const parsed = parseIncidentIssue(closed, { repository });
    if (
      !parsed
      || parsed.fingerprint !== action.signal.fingerprint
      || parsed.evidence_digest !== action.signal.evidence_digest
      || parsed.resolution !== action.resolution
      || parsed.incident_class !== live.parsed.incident_class
      || parsed.first_seen_at !== live.parsed.first_seen_at
      || parsed.occurrences !== live.parsed.occurrences
      || parsed.latest_run_id !== action.signal.latest_run_id
      || parsed.run_attempt !== action.signal.run_attempt
      || closed.state !== "closed"
    ) fail("incident_close_readback_mismatch");
    return { action: "CLOSE", issue_number: action.issue_number, fingerprint: parsed.fingerprint };
  } catch (error) {
    try {
      await restoreOpenIncident({ request, repository, live });
    } catch (restoreError) {
      throw new Error("incident_close_compensation_failed:" + error.message + ":" + restoreError.message);
    }
    throw new Error("incident_close_compensated:" + error.message);
  }
}

export async function executePlan({
  plan,
  request,
  repository,
  defaultBranch,
  pinnedCommit,
  clock = () => new Date(),
  allowCloses = false,
}) {
  const executed = [];
  for (const action of plan.upserts) {
    await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
    executed.push(await executeUpsert({ action, request, repository, defaultBranch, pinnedCommit, clock }));
  }
  if (allowCloses) {
    for (const action of plan.closes) {
      executed.push(await executeClose({ action, request, repository, defaultBranch, pinnedCommit, clock }));
    }
  }
  return executed;
}

export function selectExecutablePlan(plan) {
  if (!plan || !Array.isArray(plan.upserts) || !Array.isArray(plan.closes)) fail("invalid_incident_plan");
  const scheduled = plan.upserts
    .filter((action) => action.signal?.axis === "scheduled_liveness")
    .sort((left, right) => {
      const leftPriority = left.action === "CREATE" ? 0 : 1;
      const rightPriority = right.action === "CREATE" ? 0 : 1;
      return leftPriority - rightPriority
        || String(left.signal.fingerprint).localeCompare(String(right.signal.fingerprint));
    });
  return {
    plan: { upserts: scheduled.slice(0, MAX_SCHEDULED_UPSERTS_PER_CYCLE), closes: [] },
    execution_upserts_quarantined: plan.upserts
      .filter((action) => action.signal?.axis === "execution_health").length,
    scheduled_upserts_deferred: Math.max(0, scheduled.length - MAX_SCHEDULED_UPSERTS_PER_CYCLE),
  };
}

export async function runSentinelCycle({
  request,
  repository,
  defaultBranch,
  pinnedCommit,
  runId,
  contractText,
  now = null,
  clock = () => new Date(),
  expectedCancelledWorkflows = [],
}) {
  const snapshot = await collectSnapshot({ request, repository, defaultBranch, pinnedCommit, contractText });
  const classificationNow = now === null ? clock() : now;
  const health = classifyWorkflowHealth({
    repository,
    now: classificationNow,
    workflowInventory: snapshot.workflow_inventory,
    livenessContracts: snapshot.liveness_contracts,
    allEventRuns: snapshot.all_event_runs,
    scheduledRuns: snapshot.scheduled_runs,
    expectedCancelledWorkflows,
  });
  const incidents = await loadOpenIncidents({ request, repository });
  const plan = planIncidentActions(health.signals, incidents);
  const selected = selectExecutablePlan(plan);
  await assertSourceAuthority({ request, repository, defaultBranch, pinnedCommit });
  const stateCounts = Object.fromEntries(READBACK_STATES.map((state) => [state, health.state_counts[state] || 0]));
  const operationalState = health.overall_state === "GREEN" ? "AMBER" : health.overall_state;
  return {
    schema_version: 2,
    run_id: runId,
    pinned_commit: snapshot.pinned_commit,
    pinned_tree_sha: snapshot.pinned_tree_sha,
    contract_digest: snapshot.contract_digest,
    workflow_source_digest: snapshot.workflow_source_digest,
    coverage: health.coverage,
    workflows_observed: health.workflow_observations.length,
    overall_state: operationalState,
    state_counts: stateCounts,
    actions: [],
    write_mode: "READ_ONLY_SHADOW",
    mutation_authority: "NONE",
    closures_quarantined: plan.closes.length,
    execution_upserts_quarantined: selected.execution_upserts_quarantined,
    scheduled_upserts_quarantined: selected.scheduled_upserts_deferred,
    diagnostic_would_create: plan.upserts.filter((action) => action.action === "CREATE").length,
    diagnostic_would_update: plan.upserts.filter((action) => action.action === "UPDATE").length,
    diagnostic_would_close: plan.closes.length,
    diagnostic_incident_plan_authoritative: false,
    closure_authority: "QUARANTINE_PENDING_HISTORICAL_RERUN_NEUTRALIZATION",
    execution_history_complete: snapshot.execution_history_complete,
    public_metadata_only: true,
    mailbox_content_read: false,
    writes_allowed: false,
  };
}

async function main() {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("GITHUB_TOKEN");
  const runId = requiredEnv("GITHUB_RUN_ID");
  const defaultBranch = requiredEnv("DEFAULT_BRANCH");
  const pinnedCommit = requiredEnv("GITHUB_SHA");
  const expectedCancelledWorkflows = (process.env.EXPECTED_CANCEL_WORKFLOWS || "Kyiv V3 public collector")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const contractText = await readFile(CONTRACT_URL, "utf8");
  const request = createGithubRequest({ token });
  const readback = await runSentinelCycle({
    request,
    repository,
    defaultBranch,
    pinnedCommit,
    runId,
    contractText,
    expectedCancelledWorkflows,
  });
  console.log("ANOMALY_SENTINEL_READBACK " + JSON.stringify(readback));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
