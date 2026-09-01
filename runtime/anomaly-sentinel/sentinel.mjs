import { createHash } from "node:crypto";

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure", "stale"]);
const CONTRACT_MODES = new Set(["scheduled", "event_driven", "decommissioned", "observer"]);
const SIGNAL_PHASES = new Set(["ACTIVE", "HOLD", "CLEAR"]);
const SIGNAL_AXES = new Set(["execution_health", "scheduled_liveness"]);
const SENTINEL_ISSUE_OWNER_LOGIN = "github-actions[bot]";
const CONTRACT_FIELDS = new Set([
  "workflow_path", "workflow_name", "workflow_blob_sha", "mode", "enabled_since",
  "expected_event", "cadence_ms", "freshness_ttl_ms", "grace_ms", "recovery_min_successes",
]);

function fail(code) { throw new Error(code); }

function timestamp(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("invalid_" + field);
  return parsed;
}

function boundedString(value, field, max = 200) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) fail("invalid_" + field);
  return value;
}

function nullableString(value, field, max = 200) {
  if (value === null) return null;
  return boundedString(value, field, max);
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid_" + field);
  return value;
}

function nullablePositiveInteger(value, field) {
  if (value === null) return null;
  return positiveInteger(value, field);
}

function workflowPath(value, field = "workflow_path") {
  const path = boundedString(value, field, 300);
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) fail("invalid_" + field);
  return path;
}

function blobSha(value, field = "workflow_blob_sha") {
  const sha = boundedString(value, field, 40);
  if (!/^[0-9a-f]{40}$/.test(sha)) fail("invalid_" + field);
  return sha;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function incidentFingerprint(repository, workflowPathValue, axis) {
  const repo = boundedString(repository, "repository", 200);
  const path = workflowPath(workflowPathValue);
  if (!SIGNAL_AXES.has(axis)) fail("invalid_signal_axis");
  return "gha:v3:" + sha256(repo + "\0" + path + "\0" + axis).slice(0, 32);
}

function contractIdentity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_liveness_contract");
  const keys = Object.keys(raw);
  if (keys.some((key) => !CONTRACT_FIELDS.has(key)) || keys.length !== CONTRACT_FIELDS.size) fail("invalid_liveness_contract_fields");
  const contract = {
    workflow_path: workflowPath(raw.workflow_path, "contract_workflow_path"),
    workflow_name: boundedString(raw.workflow_name, "contract_workflow_name", 200),
    workflow_blob_sha: blobSha(raw.workflow_blob_sha, "contract_workflow_blob_sha"),
    mode: boundedString(raw.mode, "contract_mode", 40),
    enabled_since: boundedString(raw.enabled_since, "contract_enabled_since", 60),
    expected_event: raw.expected_event,
    cadence_ms: raw.cadence_ms,
    freshness_ttl_ms: raw.freshness_ttl_ms,
    grace_ms: raw.grace_ms,
    recovery_min_successes: raw.recovery_min_successes,
  };
  if (!CONTRACT_MODES.has(contract.mode)) fail("invalid_contract_mode");
  timestamp(contract.enabled_since, "contract_enabled_since");
  if (contract.mode === "scheduled") {
    if (contract.expected_event !== "schedule") fail("invalid_scheduled_expected_event");
    contract.cadence_ms = positiveInteger(contract.cadence_ms, "contract_cadence_ms");
    contract.freshness_ttl_ms = positiveInteger(contract.freshness_ttl_ms, "contract_freshness_ttl_ms");
    contract.grace_ms = positiveInteger(contract.grace_ms, "contract_grace_ms");
    contract.recovery_min_successes = positiveInteger(contract.recovery_min_successes, "contract_recovery_min_successes");
    if (contract.recovery_min_successes < 2) fail("contract_recovery_quorum_below_two");
    if (contract.freshness_ttl_ms < contract.cadence_ms + contract.grace_ms) fail("contract_ttl_below_cadence_and_grace");
  } else if (
    contract.expected_event !== null
    || nullablePositiveInteger(contract.cadence_ms, "contract_cadence_ms") !== null
    || nullablePositiveInteger(contract.freshness_ttl_ms, "contract_freshness_ttl_ms") !== null
    || nullablePositiveInteger(contract.grace_ms, "contract_grace_ms") !== null
    || contract.recovery_min_successes !== 0
  ) {
    fail("non_scheduled_contract_has_schedule_fields");
  }
  return contract;
}

export function validateLivenessContracts(contracts) {
  if (!Array.isArray(contracts) || contracts.length < 1) fail("invalid_liveness_contracts");
  const seen = new Set();
  return contracts.map((raw) => {
    const contract = contractIdentity(raw);
    if (seen.has(contract.workflow_path)) fail("duplicate_liveness_contract_path");
    seen.add(contract.workflow_path);
    return contract;
  });
}

function inventoryIdentity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_workflow_inventory");
  return {
    workflow_id: positiveInteger(raw.workflow_id ?? raw.id, "workflow_id"),
    workflow_name: boundedString(raw.workflow_name ?? raw.name, "workflow_name", 200),
    workflow_path: workflowPath(raw.workflow_path ?? raw.path),
    workflow_url: boundedString(raw.workflow_url ?? raw.html_url, "workflow_url", 500),
    workflow_state: boundedString(raw.workflow_state ?? raw.state, "workflow_state", 60),
    workflow_blob_sha: blobSha(raw.workflow_blob_sha, "inventory_workflow_blob_sha"),
  };
}

export function validateWorkflowCoverage(workflowInventory, livenessContracts) {
  if (!Array.isArray(workflowInventory)) fail("invalid_workflow_inventory");
  const contracts = validateLivenessContracts(livenessContracts);
  const contractByPath = new Map(contracts.map((contract) => [contract.workflow_path, contract]));
  const inventory = workflowInventory.map(inventoryIdentity);
  const inventoryByPath = new Map();
  const inventoryIds = new Set();
  for (const identity of inventory) {
    if (inventoryByPath.has(identity.workflow_path)) fail("duplicate_workflow_inventory_path");
    if (inventoryIds.has(identity.workflow_id)) fail("duplicate_workflow_inventory_id");
    inventoryByPath.set(identity.workflow_path, identity);
    inventoryIds.add(identity.workflow_id);
  }
  const contractPaths = [...contractByPath.keys()].sort();
  const inventoryPaths = [...inventoryByPath.keys()].sort();
  if (canonicalJson(contractPaths) !== canonicalJson(inventoryPaths)) fail("contract_inventory_path_mismatch");
  for (const contract of contracts) {
    const identity = inventoryByPath.get(contract.workflow_path);
    if (identity.workflow_name !== contract.workflow_name) fail("contract_inventory_name_mismatch");
    if (identity.workflow_blob_sha !== contract.workflow_blob_sha) fail("contract_inventory_blob_mismatch");
  }
  return { contracts, inventory };
}

function runIdentity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_run");
  const run = {
    id: positiveInteger(raw.id, "run_id"),
    run_attempt: raw.run_attempt === undefined ? 1 : positiveInteger(raw.run_attempt, "run_attempt"),
    workflow_id: positiveInteger(raw.workflow_id, "run_workflow_id"),
    workflow_name: boundedString(raw.workflow_name ?? raw.name, "run_workflow_name", 200),
    workflow_path: workflowPath(raw.workflow_path, "run_workflow_path"),
    workflow_url: boundedString(raw.workflow_url, "run_workflow_url", 500),
    head_sha: blobSha(raw.head_sha, "run_head_sha"),
    workflow_blob_sha_at_run: blobSha(raw.workflow_blob_sha_at_run, "run_workflow_blob_sha"),
    status: boundedString(raw.status, "run_status", 40),
    conclusion: nullableString(raw.conclusion, "run_conclusion", 60),
    event: boundedString(raw.event, "run_event", 60),
    created_at: boundedString(raw.created_at, "run_created_at", 60),
    run_started_at: boundedString(raw.run_started_at ?? raw.created_at, "run_started_at", 60),
    updated_at: nullableString(raw.updated_at ?? null, "run_updated_at", 60),
    html_url: boundedString(raw.html_url, "run_url", 500),
  };
  timestamp(run.created_at, "run_created_at");
  timestamp(run.run_started_at, "run_started_at");
  if (run.updated_at) timestamp(run.updated_at, "run_updated_at");
  return run;
}

function latestFirst(left, right) {
  const byTime = timestamp(right.created_at, "run_created_at") - timestamp(left.created_at, "run_created_at");
  return byTime || right.id - left.id || right.run_attempt - left.run_attempt;
}

function latestExecutionFirst(left, right) {
  const byStart = timestamp(right.run_started_at, "run_started_at") - timestamp(left.run_started_at, "run_started_at");
  const byRevision = timestamp(right.updated_at || right.run_started_at, "run_updated_at")
    - timestamp(left.updated_at || left.run_started_at, "run_updated_at");
  return byStart || byRevision || latestFirst(left, right);
}

function dedupeRuns(rawRuns, inventoryById) {
  if (!Array.isArray(rawRuns)) fail("invalid_runs");
  const byId = new Map();
  for (const raw of rawRuns) {
    const run = runIdentity(raw);
    const identity = inventoryById.get(run.workflow_id);
    if (!identity) fail("run_for_workflow_missing_from_inventory");
    if (run.workflow_path !== identity.workflow_path || run.workflow_name !== identity.workflow_name) fail("run_workflow_identity_mismatch");
    const current = byId.get(run.id);
    if (!current) {
      byId.set(run.id, run);
    } else if (run.run_attempt === current.run_attempt) {
      if (canonicalJson(run) !== canonicalJson(current)) fail("conflicting_duplicate_run_record");
    } else if (run.run_attempt > current.run_attempt) {
      byId.set(run.id, run);
    }
  }
  return [...byId.values()].sort(latestFirst);
}

function groupRuns(runs, comparator = latestFirst) {
  const grouped = new Map();
  for (const run of runs) {
    const bucket = grouped.get(run.workflow_id) || [];
    bucket.push(run);
    grouped.set(run.workflow_id, bucket);
  }
  for (const bucket of grouped.values()) bucket.sort(comparator);
  return grouped;
}

function signal(identity, repository, axis, phase, state, incidentClass, reason, latest, nowMs, extra = {}) {
  if (!SIGNAL_AXES.has(axis) || !SIGNAL_PHASES.has(phase)) fail("invalid_signal");
  const evidenceAt = latest
    ? (axis === "execution_health" ? latest.run_started_at : latest.created_at)
    : new Date(nowMs).toISOString();
  const evidence = {
    axis, phase, state, incident_class: incidentClass,
    workflow_state: identity.workflow_state,
    workflow_blob_sha: identity.workflow_blob_sha,
    latest_run_id: latest?.id || 0,
    run_attempt: latest?.run_attempt || 0,
    run_event: latest?.event || null,
    run_status: latest?.status || null,
    run_conclusion: latest?.conclusion || null,
    latest_head_sha: latest?.head_sha || null,
    latest_workflow_blob_sha: latest?.workflow_blob_sha_at_run || null,
    evidence_at: evidenceAt,
    evidence_revision_at: latest?.updated_at || latest?.created_at || new Date(nowMs).toISOString(),
    healthy_pulse_streak: extra.healthy_pulse_streak ?? null,
    required_healthy_pulses: extra.required_healthy_pulses ?? null,
    recovery_pulses: extra.recovery_pulses ?? null,
    cadence_ms: extra.cadence_ms ?? null,
    grace_ms: extra.grace_ms ?? null,
    freshness_ttl_ms: extra.freshness_ttl_ms ?? null,
  };
  return {
    ...evidence, ...extra, reason,
    fingerprint: incidentFingerprint(repository, identity.workflow_path, axis),
    evidence_digest: sha256(canonicalJson(evidence)),
    workflow_id: identity.workflow_id,
    workflow_name: identity.workflow_name,
    workflow_path: identity.workflow_path,
    workflow_url: identity.workflow_url,
    workflow_state: identity.workflow_state,
    workflow_blob_sha: identity.workflow_blob_sha,
    latest_run_url: latest?.html_url || identity.workflow_url,
    observed_at: new Date(nowMs).toISOString(),
  };
}

function assertRunTime(run, nowMs) {
  const createdAt = timestamp(run.created_at, "run_created_at");
  const startedAt = timestamp(run.run_started_at, "run_started_at");
  const updatedAt = timestamp(run.updated_at || run.created_at, "run_updated_at");
  if (createdAt - nowMs > 5 * 60_000 || startedAt - nowMs > 5 * 60_000 || updatedAt - nowMs > 5 * 60_000) fail("run_timestamp_in_future");
  return { createdAt, startedAt, updatedAt };
}

function classifyExecution(identity, bucket, options) {
  const { repository, nowMs, expectedCancelled, failureGraceMs, executionStaleMs } = options;
  const latest = bucket[0] || null;
  if (!latest) return signal(identity, repository, "execution_health", "HOLD", "UNKNOWN", "no_execution_history", "workflow has no default-branch run history", null, nowMs);
  const { createdAt, startedAt, updatedAt } = assertRunTime(latest, nowMs);
  if (createdAt > nowMs || startedAt > nowMs || updatedAt > nowMs) {
    return signal(identity, repository, "execution_health", "HOLD", "UNKNOWN", "future_run_clock_skew", "future-dated run evidence cannot certify execution health", latest, nowMs);
  }
  if (latest.workflow_blob_sha_at_run !== identity.workflow_blob_sha) {
    return signal(identity, repository, "execution_health", "ACTIVE", "ACTIVE_FAILURE", "workflow_source_mismatch", "latest execution used a workflow blob other than the pinned current source", latest, nowMs);
  }
  if (latest.status !== "completed") {
    return nowMs - startedAt >= executionStaleMs
      ? signal(identity, repository, "execution_health", "ACTIVE", "ACTIVE_FAILURE", "stale_run", "latest run exceeded the bounded execution threshold", latest, nowMs)
      : signal(identity, repository, "execution_health", "HOLD", "RUNNING", "run_in_progress", "latest run remains inside its execution window", latest, nowMs);
  }
  if (FAILURE_CONCLUSIONS.has(latest.conclusion)) {
    return nowMs - updatedAt >= failureGraceMs
      ? signal(identity, repository, "execution_health", "ACTIVE", "ACTIVE_FAILURE", "workflow_" + latest.conclusion, "latest terminal conclusion is " + latest.conclusion, latest, nowMs)
      : signal(identity, repository, "execution_health", "HOLD", "UNKNOWN", "failure_grace", "terminal failure remains inside the anti-race grace window", latest, nowMs);
  }
  if (latest.conclusion === "cancelled") {
    const expected = expectedCancelled.has(identity.workflow_name);
    return signal(identity, repository, "execution_health", "HOLD", expected ? "EXPECTED_CANCEL" : "UNKNOWN", expected ? "expected_cancel" : "unexpected_cancel", expected ? "workflow cancellation is allowlisted for concurrency replacement" : "workflow cancellation is not allowlisted", latest, nowMs);
  }
  if (latest.conclusion === "success") {
    const previousFailure = bucket.slice(1).some((run) => FAILURE_CONCLUSIONS.has(run.conclusion));
    return signal(identity, repository, "execution_health", "CLEAR", previousFailure ? "RECOVERED_INCIDENT" : "HEALTHY", "execution_success", previousFailure ? "newer successful execution supersedes prior execution failure" : "latest execution completed successfully", latest, nowMs);
  }
  return signal(identity, repository, "execution_health", "HOLD", "UNKNOWN", "non_success_terminal", "terminal skipped or neutral result cannot certify recovery", latest, nowMs);
}

function successfulPulses(bucket, contract, nowMs) {
  const pulses = [];
  let newerCreatedAt = null;
  const minimumGap = Math.max(60_000, Math.floor(contract.cadence_ms / 2), contract.cadence_ms - contract.grace_ms);
  const maximumGap = contract.cadence_ms + contract.grace_ms;
  for (const run of bucket) {
    const createdAt = timestamp(run.created_at, "run_created_at");
    const startedAt = timestamp(run.run_started_at, "run_started_at");
    const updatedAt = timestamp(run.updated_at || run.created_at, "run_updated_at");
    if (
      run.event !== "schedule"
      || run.run_attempt !== 1
      || run.status !== "completed"
      || run.conclusion !== "success"
      || run.workflow_blob_sha_at_run !== contract.workflow_blob_sha
      || createdAt > nowMs
      || startedAt > nowMs
      || updatedAt > nowMs
    ) break;
    if (newerCreatedAt !== null) {
      const gap = newerCreatedAt - createdAt;
      if (gap < minimumGap || gap > maximumGap) break;
    }
    pulses.push({
      id: run.id,
      run_attempt: run.run_attempt,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      created_at: run.created_at,
      head_sha: run.head_sha,
      updated_at: run.updated_at,
      workflow_blob_sha_at_run: run.workflow_blob_sha_at_run,
    });
    newerCreatedAt = createdAt;
  }
  return pulses;
}

function classifyScheduleLiveness(identity, bucket, contract, options) {
  const { repository, nowMs } = options;
  const scheduleContext = {
    required_healthy_pulses: contract.recovery_min_successes,
    cadence_ms: contract.cadence_ms,
    grace_ms: contract.grace_ms,
    freshness_ttl_ms: contract.freshness_ttl_ms,
  };
  const latest = bucket[0] || null;
  if (!latest) {
    const enabledAgeMs = nowMs - timestamp(contract.enabled_since, "contract_enabled_since");
    return enabledAgeMs >= contract.freshness_ttl_ms
      ? signal(identity, repository, "scheduled_liveness", "ACTIVE", "ACTIVE_FAILURE", "missing_expected_run", "no scheduled run exists inside the workflow freshness window", null, nowMs, scheduleContext)
      : signal(identity, repository, "scheduled_liveness", "HOLD", "UNKNOWN", "activation_window", "scheduled workflow remains inside its initial activation window", null, nowMs, scheduleContext);
  }
  if (latest.event !== "schedule") fail("non_schedule_run_in_schedule_history");
  const { createdAt, startedAt, updatedAt } = assertRunTime(latest, nowMs);
  if (createdAt > nowMs || startedAt > nowMs || updatedAt > nowMs) {
    return signal(identity, repository, "scheduled_liveness", "HOLD", "UNKNOWN", "future_pulse_clock_skew", "future-dated scheduled evidence cannot certify liveness", latest, nowMs, scheduleContext);
  }
  if (latest.workflow_blob_sha_at_run !== contract.workflow_blob_sha) {
    return signal(identity, repository, "scheduled_liveness", "ACTIVE", "ACTIVE_FAILURE", "workflow_source_mismatch", "latest scheduled pulse used a workflow blob other than the pinned current source", latest, nowMs, scheduleContext);
  }
  const ageMs = nowMs - createdAt;
  if (ageMs >= contract.freshness_ttl_ms) {
    return latest.status === "completed" && latest.conclusion === "success"
      ? signal(identity, repository, "scheduled_liveness", "ACTIVE", "STALE_SUCCESS", "stale_success", "latest successful scheduled pulse exceeded its freshness TTL", latest, nowMs, scheduleContext)
      : signal(identity, repository, "scheduled_liveness", "ACTIVE", "ACTIVE_FAILURE", "missing_expected_run", "latest scheduled evidence exceeded its freshness TTL", latest, nowMs, scheduleContext);
  }
  if (latest.run_attempt !== 1) {
    return signal(identity, repository, "scheduled_liveness", "HOLD", "UNKNOWN", "scheduled_rerun_not_liveness_evidence", "a rerun attempt cannot certify or fail scheduler liveness", latest, nowMs, scheduleContext);
  }
  if (latest.status === "completed" && FAILURE_CONCLUSIONS.has(latest.conclusion)) {
    return signal(
      identity,
      repository,
      "scheduled_liveness",
      "ACTIVE",
      "ACTIVE_FAILURE",
      "scheduled_workflow_" + latest.conclusion,
      "latest scheduled execution ended with " + latest.conclusion,
      latest,
      nowMs,
      scheduleContext,
    );
  }
  const pulses = successfulPulses(bucket, contract, nowMs);
  const pulse = {
    ...scheduleContext,
    healthy_pulse_streak: pulses.length,
    recovery_pulses: pulses.slice(0, contract.recovery_min_successes),
  };
  if (pulses.length < contract.recovery_min_successes) return signal(identity, repository, "scheduled_liveness", "HOLD", "RECOVERY_PENDING", "recovery_pending", "scheduled liveness requires a sustained quorum of distinct successful pulses", latest, nowMs, pulse);
  return signal(identity, repository, "scheduled_liveness", "CLEAR", "FRESH", "scheduled_liveness_fresh", "scheduled liveness has a sustained fresh success quorum", latest, nowMs, pulse);
}

function overallState(signals) {
  if (signals.some((item) => item.phase === "ACTIVE")) return "RED";
  if (signals.some((item) => item.phase === "HOLD")) return "AMBER";
  return "GREEN";
}

export function classifyWorkflowHealth({
  repository, now = new Date(), workflowInventory = [], livenessContracts = [],
  allEventRuns = [], scheduledRuns = [], expectedCancelledWorkflows = [],
  failureGraceMs = 60_000, executionStaleMs = 30 * 60_000,
} = {}) {
  const repo = boundedString(repository, "repository", 200);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) fail("invalid_now");
  const { contracts, inventory } = validateWorkflowCoverage(workflowInventory, livenessContracts);
  const contractByPath = new Map(contracts.map((contract) => [contract.workflow_path, contract]));
  const inventoryById = new Map(inventory.map((identity) => [identity.workflow_id, identity]));
  const allRuns = dedupeRuns(allEventRuns, inventoryById);
  const scheduleOnlyRuns = dedupeRuns(scheduledRuns, inventoryById);
  if (scheduleOnlyRuns.some((run) => run.event !== "schedule")) fail("non_schedule_run_in_schedule_history");
  const allGrouped = groupRuns(allRuns, latestExecutionFirst);
  const scheduleGrouped = groupRuns(scheduleOnlyRuns);
  const expectedCancelled = new Set(expectedCancelledWorkflows);
  const workflowObservations = [];
  const signals = [];
  for (const identity of inventory.slice().sort((left, right) => left.workflow_path.localeCompare(right.workflow_path))) {
    const contract = contractByPath.get(identity.workflow_path);
    if (timestamp(contract.enabled_since, "contract_enabled_since") - nowMs > 5 * 60_000) fail("contract_enabled_since_in_future");
    if (contract.mode === "observer" && identity.workflow_state === "active") {
      workflowObservations.push({ identity, mode: contract.mode, execution: null, schedule_liveness: null, overall_state: "OBSERVER" });
      continue;
    }
    if (contract.mode === "decommissioned") {
      const execution = signal(identity, repo, "execution_health", "CLEAR", "DECOMMISSIONED", "explicit_decommission", "workflow is explicitly decommissioned by its pinned contract", null, nowMs, { decommissioned: true });
      const scheduleLiveness = signal(identity, repo, "scheduled_liveness", "CLEAR", "DECOMMISSIONED", "explicit_decommission", "workflow is explicitly decommissioned by its pinned contract", null, nowMs, { decommissioned: true });
      signals.push(execution, scheduleLiveness);
      workflowObservations.push({ identity, mode: contract.mode, execution, schedule_liveness: scheduleLiveness, overall_state: "DECOMMISSIONED" });
      continue;
    }
    if (identity.workflow_state !== "active") {
      const execution = signal(
        identity,
        repo,
        "execution_health",
        "ACTIVE",
        "ACTIVE_FAILURE",
        "workflow_disabled",
        "non-decommissioned workflow API state is " + identity.workflow_state,
        null,
        nowMs,
      );
      const scheduleLiveness = contract.mode === "scheduled"
        ? signal(identity, repo, "scheduled_liveness", "ACTIVE", "ACTIVE_FAILURE", "workflow_disabled", "scheduled workflow API state is " + identity.workflow_state, null, nowMs, {
          required_healthy_pulses: contract.recovery_min_successes,
          cadence_ms: contract.cadence_ms,
          grace_ms: contract.grace_ms,
          freshness_ttl_ms: contract.freshness_ttl_ms,
        })
        : null;
      const axes = scheduleLiveness ? [execution, scheduleLiveness] : [execution];
      signals.push(...axes);
      workflowObservations.push({ identity, mode: contract.mode, execution, schedule_liveness: scheduleLiveness, overall_state: "RED" });
      continue;
    }
    const execution = classifyExecution(identity, allGrouped.get(identity.workflow_id) || [], {
      repository: repo, nowMs, expectedCancelled, failureGraceMs, executionStaleMs,
    });
    const scheduleLiveness = contract.mode === "scheduled"
      ? classifyScheduleLiveness(identity, scheduleGrouped.get(identity.workflow_id) || [], contract, { repository: repo, nowMs })
      : null;
    const axes = scheduleLiveness ? [execution, scheduleLiveness] : [execution];
    signals.push(...axes);
    workflowObservations.push({ identity, mode: contract.mode, execution, schedule_liveness: scheduleLiveness, overall_state: overallState(axes) });
  }
  const stateCounts = {};
  for (const item of signals) stateCounts[item.state] = (stateCounts[item.state] || 0) + 1;
  const monitored = workflowObservations.filter((item) => !["OBSERVER", "DECOMMISSIONED"].includes(item.overall_state));
  const aggregate = monitored.some((item) => item.overall_state === "RED") ? "RED"
    : monitored.some((item) => item.overall_state !== "GREEN") ? "AMBER" : "GREEN";
  return {
    coverage: { complete: true, contract_count: contracts.length, inventory_count: inventory.length },
    workflow_observations: workflowObservations,
    signals,
    active_fingerprints: signals.filter((item) => item.phase === "ACTIVE").map((item) => item.fingerprint),
    held_fingerprints: signals.filter((item) => item.phase === "HOLD").map((item) => item.fingerprint),
    resolved_fingerprints: signals.filter((item) => item.phase === "CLEAR").map((item) => item.fingerprint),
    state_counts: stateCounts,
    overall_state: aggregate,
    writes_allowed: false,
  };
}

function safeWorkflowName(name) {
  return boundedString(name, "workflow_name", 200).replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim();
}

function safeReason(reason) {
  return boundedString(reason, "reason", 500).replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim();
}

function safePublicGithubUrl(value) {
  const candidate = boundedString(value, "public_github_url", 500);
  if (/[\r\n<>\s]/.test(candidate)) fail("invalid_public_github_url");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    fail("invalid_public_github_url");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.href !== candidate) {
    fail("invalid_public_github_url");
  }
  return candidate;
}

export function renderIncidentTitle(signalValue) {
  return ("[ANOMALY] GitHub workflow: " + safeWorkflowName(signalValue.workflow_name)).slice(0, 240);
}

export function renderIncidentBody(signalValue, { occurrences = 1, firstSeenAt = signalValue.observed_at, resolution = null, existingIncident = null } = {}) {
  const source = existingIncident || signalValue;
  if (!SIGNAL_AXES.has(source.axis)) fail("invalid_incident_axis");
  const fingerprint = boundedString(source.fingerprint, "fingerprint", 64);
  if (!/^gha:v3:[0-9a-f]{32}$/.test(fingerprint)) fail("invalid_fingerprint");
  const path = workflowPath(source.workflow_path);
  const incidentClass = boundedString(source.incident_class, "incident_class", 100);
  const marker = "<!-- jarvis-anomaly-sentinel:v3 owner=runtime-anomaly-sentinel fingerprint=" + fingerprint + " axis=" + source.axis + " -->";
  return [
    marker,
    "**RUNTIME ANOMALY SENTINEL**",
    "- state: **" + (resolution ? "RESOLVED" : signalValue.state) + "**",
    "- workflow: " + safeWorkflowName(source.workflow_name),
    "- workflow_id: " + source.workflow_id,
    "- workflow_path: " + path,
    "- axis: " + source.axis,
    "- incident_class: " + incidentClass,
    "- current_subtype: " + signalValue.incident_class,
    "- fingerprint: " + fingerprint,
    "- occurrences: " + occurrences,
    "- first_seen_utc: " + firstSeenAt,
    "- last_seen_utc: " + signalValue.observed_at,
    "- evidence_at_utc: " + signalValue.evidence_at,
    "- evidence_revision_at_utc: " + signalValue.evidence_revision_at,
    "- latest_run_id: " + signalValue.latest_run_id,
    "- run_attempt: " + signalValue.run_attempt,
    "- latest_run: " + safePublicGithubUrl(signalValue.latest_run_url),
    "- evidence_digest: " + signalValue.evidence_digest,
    "- reason: " + safeReason(signalValue.reason),
    resolution ? "- resolution: " + resolution : null,
    "- data_boundary: public GitHub runtime metadata only",
    "- mailbox_or_private_content_published: false",
  ].filter(Boolean).join("\n");
}

function parseField(body, pattern, fallback = null) {
  return (body.match(pattern) || [])[1] || fallback;
}

export function parseIncidentIssue(issue, { repository } = {}) {
  if (
    !issue
    || !Number.isInteger(issue.number)
    || typeof issue.body !== "string"
    || issue.user?.login !== SENTINEL_ISSUE_OWNER_LOGIN
    || issue.user?.type !== "Bot"
  ) return null;
  const body = issue.body;
  const lines = body.includes("\r") ? [] : body.split("\n");
  const marker = lines[0]?.match(/^<!-- jarvis-anomaly-sentinel:v3 owner=runtime-anomaly-sentinel fingerprint=(gha:v3:[0-9a-f]{32}) axis=(execution_health|scheduled_liveness) -->$/);
  if (marker) {
    const hasResolution = lines.length === 23;
    if (lines.length !== 22 && !hasResolution) return null;
    const exact = (index, pattern) => lines[index]?.match(pattern)?.[1] || null;
    if (lines[1] !== "**RUNTIME ANOMALY SENTINEL**") return null;
    const displayedState = exact(2, /^- state: \*\*([A-Z_]+)\*\*$/);
    const workflowNameValue = exact(3, /^- workflow: ([^\r\n]+)$/);
    const workflowId = Number(exact(4, /^- workflow_id: (\d+)$/) || "0");
    const path = exact(5, /^- workflow_path: (\.github\/workflows\/[^/]+\.ya?ml)$/i);
    const bodyAxis = exact(6, /^- axis: (execution_health|scheduled_liveness)$/);
    const incidentClass = exact(7, /^- incident_class: ([a-z0-9_]+)$/);
    const currentSubtype = exact(8, /^- current_subtype: ([a-z0-9_]+)$/);
    const bodyFingerprint = exact(9, /^- fingerprint: (gha:v3:[0-9a-f]{32})$/);
    const occurrences = Number(exact(10, /^- occurrences: (\d+)$/) || "0");
    const firstSeenAt = exact(11, /^- first_seen_utc: ([^\r\n]+)$/);
    const lastSeenAt = exact(12, /^- last_seen_utc: ([^\r\n]+)$/);
    const evidenceAt = exact(13, /^- evidence_at_utc: ([^\r\n]+)$/);
    const evidenceRevisionAt = exact(14, /^- evidence_revision_at_utc: ([^\r\n]+)$/);
    const latestRunId = Number(exact(15, /^- latest_run_id: (\d+)$/) || "-1");
    const runAttempt = Number(exact(16, /^- run_attempt: (\d+)$/) || "-1");
    const latestRunUrl = exact(17, /^- latest_run: (https:\/\/github\.com\/[^\r\n<>\s]+)$/);
    const evidenceDigest = exact(18, /^- evidence_digest: ([0-9a-f]{64})$/);
    const displayedReason = exact(19, /^- reason: ([^\r\n]+)$/);
    const resolution = hasResolution ? exact(20, /^- resolution: (RECOVERED|DECOMMISSIONED)$/) : null;
    const boundaryIndex = hasResolution ? 21 : 20;
    const expectedTitle = ("[ANOMALY] GitHub workflow: " + safeWorkflowName(workflowNameValue)).slice(0, 240);
    if (
      !path || !workflowNameValue || !incidentClass || !currentSubtype || !displayedState || !displayedReason || !evidenceDigest
      || !latestRunUrl || (hasResolution && !resolution)
      || (displayedState === "RESOLVED") !== hasResolution
      || bodyAxis !== marker[2] || bodyFingerprint !== marker[1]
      || !Number.isSafeInteger(workflowId) || workflowId < 1
      || !Number.isSafeInteger(occurrences) || occurrences < 1
      || !Number.isSafeInteger(latestRunId) || latestRunId < 0
      || !Number.isSafeInteger(runAttempt) || runAttempt < 0
      || !firstSeenAt || !lastSeenAt || !evidenceAt
      || !evidenceRevisionAt
      || !Number.isFinite(Date.parse(firstSeenAt))
      || !Number.isFinite(Date.parse(lastSeenAt))
      || !Number.isFinite(Date.parse(evidenceAt))
      || !Number.isFinite(Date.parse(evidenceRevisionAt))
      || lines[boundaryIndex] !== "- data_boundary: public GitHub runtime metadata only"
      || lines[boundaryIndex + 1] !== "- mailbox_or_private_content_published: false"
      || issue.title !== expectedTitle
    ) return null;
    try {
      safePublicGithubUrl(latestRunUrl);
    } catch {
      return null;
    }
    if (latestRunId > 0 && !latestRunUrl.includes("/actions/runs/" + latestRunId)) return null;
    const expected = incidentFingerprint(repository, path, marker[2]);
    if (expected !== marker[1]) return null;
    return {
      issue_number: issue.number, issue_state: issue.state || "open", legacy: false,
      fingerprint: marker[1], axis: marker[2], workflow_id: workflowId,
      workflow_name: workflowNameValue, workflow_path: path, incident_class: incidentClass,
      current_subtype: currentSubtype, displayed_state: displayedState, displayed_reason: displayedReason,
      occurrences,
      latest_run_id: latestRunId,
      latest_run_url: latestRunUrl,
      run_attempt: runAttempt,
      first_seen_at: firstSeenAt,
      last_seen_at: lastSeenAt,
      evidence_at: evidenceAt,
      evidence_revision_at: evidenceRevisionAt,
      evidence_digest: evidenceDigest,
      resolution,
      issue_title: issue.title,
    };
  }
  const legacyMarker = body.match(/<!-- jarvis-anomaly-sentinel:v([12]) workflow_id=(\d+) fingerprint=(gha:v[12]:[0-9a-f]{32}) -->/);
  if (!legacyMarker) return null;
  const incidentClass = parseField(body, /^- incident_class: ([a-z0-9_]+)$/m);
  const legacyExpected = "gha:v" + legacyMarker[1] + ":" + sha256(legacyMarker[2] + "|" + incidentClass).slice(0, 32);
  if (!incidentClass || legacyExpected !== legacyMarker[3]) return null;
  return { issue_number: issue.number, issue_state: issue.state || "open", legacy: true, fingerprint: legacyMarker[3], workflow_id: Number(legacyMarker[2]), incident_class: incidentClass };
}

function evidenceIsNewer(signalValue, incident) {
  if (signalValue.decommissioned) return true;
  if (!incident.evidence_at) return false;
  const signalAt = timestamp(signalValue.evidence_at, "signal_evidence_at");
  const incidentAt = timestamp(incident.evidence_at, "incident_evidence_at");
  const signalRevisionAt = timestamp(signalValue.evidence_revision_at, "signal_evidence_revision_at");
  const incidentRevisionAt = timestamp(incident.evidence_revision_at || incident.evidence_at, "incident_evidence_revision_at");
  return signalAt > incidentAt
    || (signalAt === incidentAt && signalValue.latest_run_id > incident.latest_run_id)
    || (
      signalAt === incidentAt
      && signalValue.latest_run_id === incident.latest_run_id
      && signalValue.run_attempt > incident.run_attempt
    )
    || (
      signalAt === incidentAt
      && signalValue.latest_run_id === incident.latest_run_id
      && signalValue.run_attempt === incident.run_attempt
      && signalRevisionAt > incidentRevisionAt
    );
}

function evidenceIsNotOlder(signalValue, incident) {
  if (signalValue.decommissioned) return true;
  if (!incident.evidence_at) return false;
  const signalAt = timestamp(signalValue.evidence_at, "signal_evidence_at");
  const incidentAt = timestamp(incident.evidence_at, "incident_evidence_at");
  const signalRevisionAt = timestamp(signalValue.evidence_revision_at, "signal_evidence_revision_at");
  const incidentRevisionAt = timestamp(incident.evidence_revision_at || incident.evidence_at, "incident_evidence_revision_at");
  return signalAt > incidentAt
    || (signalAt === incidentAt && signalValue.latest_run_id > incident.latest_run_id)
    || (
      signalAt === incidentAt
      && signalValue.latest_run_id === incident.latest_run_id
      && signalValue.run_attempt > incident.run_attempt
    )
    || (
      signalAt === incidentAt
      && signalValue.latest_run_id === incident.latest_run_id
      && signalValue.run_attempt === incident.run_attempt
      && signalRevisionAt >= incidentRevisionAt
    );
}

function incidentEvidenceIsAheadOfObservation(signalValue, incident) {
  const observedAt = timestamp(signalValue.observed_at, "signal_observed_at");
  const maximum = observedAt + 5 * 60_000;
  return [incident.first_seen_at, incident.last_seen_at, incident.evidence_at, incident.evidence_revision_at]
    .filter(Boolean)
    .some((value) => timestamp(value, "incident_timestamp") > maximum);
}

function incidentPresentationMatchesSignal(signalValue, incident) {
  return incident.evidence_digest === signalValue.evidence_digest
    && incident.latest_run_id === signalValue.latest_run_id
    && incident.latest_run_url === signalValue.latest_run_url
    && incident.run_attempt === signalValue.run_attempt
    && incident.evidence_at === signalValue.evidence_at
    && (incident.evidence_revision_at || incident.evidence_at) === signalValue.evidence_revision_at
    && incident.current_subtype === signalValue.incident_class
    && incident.displayed_state === signalValue.state
    && incident.displayed_reason === safeReason(signalValue.reason);
}

export function planIncidentActions(signals, openIncidents = []) {
  if (!Array.isArray(signals) || !Array.isArray(openIncidents)) fail("invalid_incident_plan_input");
  const openByFingerprint = new Map();
  for (const incident of openIncidents.filter((item) => item && item.legacy === false)) {
    if (openByFingerprint.has(incident.fingerprint)) fail("duplicate_canonical_incident");
    openByFingerprint.set(incident.fingerprint, incident);
  }
  const seenSignals = new Set();
  const upserts = [];
  const closes = [];
  for (const signalValue of signals) {
    if (seenSignals.has(signalValue.fingerprint)) fail("duplicate_incident_signal");
    seenSignals.add(signalValue.fingerprint);
    const exact = openByFingerprint.get(signalValue.fingerprint);
    const presentationMismatch = exact
      ? !incidentPresentationMatchesSignal(signalValue, exact)
      : false;
    const repairUntrustedProvenance = exact
      ? incidentEvidenceIsAheadOfObservation(signalValue, exact)
      : false;
    if (signalValue.phase === "ACTIVE") {
      if (!exact) upserts.push({ action: "CREATE", signal: signalValue, occurrences: 1 });
      else if (
        repairUntrustedProvenance
        || (presentationMismatch && evidenceIsNotOlder(signalValue, exact))
      ) upserts.push({ action: "UPDATE", issue_number: exact.issue_number, signal: signalValue, existing_incident: exact, occurrences: (exact.occurrences || 1) + 1, repair_untrusted_provenance: repairUntrustedProvenance });
    } else if (signalValue.phase === "HOLD") {
      if (exact && (
        repairUntrustedProvenance
        || (presentationMismatch && evidenceIsNotOlder(signalValue, exact))
      )) upserts.push({ action: "UPDATE", issue_number: exact.issue_number, signal: signalValue, existing_incident: exact, occurrences: exact.occurrences || 1, repair_untrusted_provenance: repairUntrustedProvenance });
    } else if (signalValue.phase === "CLEAR" && exact && evidenceIsNewer(signalValue, exact)) {
      closes.push({ action: "CLOSE", issue_number: exact.issue_number, signal: signalValue, existing_incident: exact, resolution: signalValue.decommissioned ? "DECOMMISSIONED" : "RECOVERED" });
    }
  }
  return { upserts, closes };
}

export { CONTRACT_MODES, FAILURE_CONCLUSIONS, SIGNAL_AXES, SIGNAL_PHASES };
