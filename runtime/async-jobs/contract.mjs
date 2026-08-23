const ALLOWED_JOB_TYPES = new Set([
  "heartbeat_probe",
  "utility_search_self_test",
]);

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

  return {
    schema_version: 1,
    job_type: job.job_type,
    sensitivity: "public",
    payload: job.payload ?? {},
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
}) {
  return {
    job_id: `${repository}#${issueNumber}/run-${runId}`,
    state,
    step,
    detail,
    heartbeat_utc: new Date().toISOString(),
    execution_surface: "github_actions_public_runtime",
    chat_blocking: false,
    policy_target: {
      foreground_control_plane_max_pct: 40,
      reserve_min_pct: 60,
    },
  };
}

export { ALLOWED_JOB_TYPES };
