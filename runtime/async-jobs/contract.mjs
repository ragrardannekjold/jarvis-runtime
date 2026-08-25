const ALLOWED_JOB_TYPES = new Set([
  "heartbeat_probe",
  "utility_search_self_test",
  "intentional_failure_probe",
  "checkpoint_recovery_probe",
]);

const CANONICAL_ID_RE = /^[A-Za-z0-9._:/#-]{1,128}$/;

function canonicalId(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CANONICAL_ID_RE.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

export function extractCanonicalIds(rawBody) {
  let job;
  try {
    job = JSON.parse(rawBody || "{}");
  } catch {
    return { mission_id: null, route_id: null, cell_id: null };
  }
  const payload = job.payload ?? {};
  try {
    return {
      mission_id: canonicalId(payload.mission_id, "mission_id"),
      route_id: canonicalId(payload.route_id, "route_id"),
      cell_id: canonicalId(payload.cell_id, "cell_id"),
    };
  } catch {
    return { mission_id: null, route_id: null, cell_id: null };
  }
}

export function parseJobBody(rawBody) {
  let job;
  try {
    job = JSON.parse(rawBody || "{}");
  } catch {
    throw new Error("invalid_json");
  }

  if (job.schema_version !== 1) throw new Error("unsupported_schema_version");
  if (job.sensitivity !== "public") throw new Error("public_runtime_requires_public_sensitivity");
  if (!ALLOWED_JOB_TYPES.has(job.job_type)) throw new Error("job_type_not_allowlisted");
  if (job.payload_ref !== undefined) throw new Error("private_payload_ref_not_enabled");

  const serializedPayload = JSON.stringify(job.payload ?? {});
  if (serializedPayload.length > 2048) throw new Error("payload_too_large");

  const canonical = extractCanonicalIds(rawBody);
  const suppliedCanonicalCount = [canonical.mission_id, canonical.route_id, canonical.cell_id]
    .filter(Boolean).length;
  if (suppliedCanonicalCount !== 0 && suppliedCanonicalCount !== 3) {
    throw new Error("canonical_ids_must_be_complete");
  }

  return {
    schema_version: 1,
    job_type: job.job_type,
    sensitivity: "public",
    payload: job.payload ?? {},
    canonical,
    workload_class: ["normal", "burst"].includes(job.workload_class)
      ? job.workload_class
      : "normal",
  };
}

export function buildStatus({
  repository,
  issueNumber,
  runId,
  state,
  step,
  detail = null,
  canonical = {},
}) {
  return {
    job_id: `${repository}#${issueNumber}/run-${runId}`,
    mission_id: canonical.mission_id ?? null,
    route_id: canonical.route_id ?? null,
    cell_id: canonical.cell_id ?? null,
    state,
    step,
    detail,
    heartbeat_utc: new Date().toISOString(),
    checkpoint_ref: `https://github.com/${repository}/issues/${issueNumber}#run-${runId}`,
    execution_surface: "github_actions_public_runtime",
    chat_blocking: false,
    policy_target: {
      foreground_control_plane_max_pct: 40,
      reserve_min_pct: 60,
    },
  };
}

export { ALLOWED_JOB_TYPES };
