const PUBLIC_TRIGGER_KEYS = new Set(["schema_version", "job_ref"]);
const PRIVATE_JOB_TYPES = new Set([
  "private_integrity_probe",
  "command_center_validation",
]);

const JOB_REF_RE = /^paj-[a-f0-9]{24}$/;

export function parsePublicTrigger(rawBody) {
  let trigger;
  try {
    trigger = JSON.parse(rawBody || "{}");
  } catch {
    throw new Error("invalid_json");
  }

  if (trigger.schema_version !== 1) throw new Error("unsupported_schema_version");
  const keys = Object.keys(trigger);
  if (keys.some((key) => !PUBLIC_TRIGGER_KEYS.has(key))) {
    throw new Error("public_trigger_must_be_opaque_reference_only");
  }
  if (!JOB_REF_RE.test(trigger.job_ref || "")) throw new Error("invalid_job_ref");

  return { schema_version: 1, job_ref: trigger.job_ref };
}

export function parsePrivateJob(rawJob, expectedJobRef) {
  const job = typeof rawJob === "string" ? JSON.parse(rawJob) : rawJob;
  if (!job || typeof job !== "object") throw new Error("invalid_private_job");
  if (job.schema_version !== 1) throw new Error("unsupported_private_schema_version");
  if (job.job_ref !== expectedJobRef) throw new Error("private_job_ref_mismatch");
  if (job.sensitivity !== "private") throw new Error("private_job_requires_private_sensitivity");
  if (!PRIVATE_JOB_TYPES.has(job.job_type)) throw new Error("private_job_type_not_allowlisted");

  const serializedPayload = JSON.stringify(job.payload ?? {});
  if (serializedPayload.length > 32768) throw new Error("private_payload_too_large");

  return {
    schema_version: 1,
    job_ref: job.job_ref,
    job_type: job.job_type,
    sensitivity: "private",
    workload_class: ["normal", "burst"].includes(job.workload_class)
      ? job.workload_class
      : "normal",
    payload: job.payload ?? {},
  };
}

export function buildPublicStatus({ repository, issueNumber, runId, jobRef, state, step }) {
  return {
    job_id: `${repository}#${issueNumber}/run-${runId}`,
    job_ref: jobRef,
    state,
    step,
    heartbeat_utc: new Date().toISOString(),
    execution_surface: "github_actions_private_reference_bridge",
    chat_blocking: false,
    public_payload_exposed: false,
    public_result_exposed: false,
    policy_target: {
      foreground_control_plane_max_pct: 40,
      reserve_min_pct: 60,
    },
  };
}

export { JOB_REF_RE, PRIVATE_JOB_TYPES, PUBLIC_TRIGGER_KEYS };
