const RAW_KEY_NAMES = Object.freeze(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]);

export const CLAUDE_PROVIDER_ID = "anthropic.claude";
export const CLAUDE_READINESS_SCHEMA = 1;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function assessClaudeReadiness(environment = process.env) {
  const rawCredentialVisible = RAW_KEY_NAMES.some((name) => nonEmptyString(environment[name]));
  const credentialRefPresent = nonEmptyString(environment.CLAUDE_API_KEY_REF);

  if (rawCredentialVisible) {
    return Object.freeze({
      schema_version: CLAUDE_READINESS_SCHEMA,
      provider_id: CLAUDE_PROVIDER_ID,
      state: "REJECTED_RAW_CREDENTIAL_EXPOSURE",
      adapter_contract: "PROVIDER_NEUTRAL_READY",
      credential_reference_present: credentialRefPresent,
      raw_credential_visible: true,
      authenticated_canary: false,
      paid_execution_authorized: false,
      next_gate: "MOVE_SECRET_TO_PRIVATE_REFERENCE_RESOLVER",
    });
  }

  if (!credentialRefPresent) {
    return Object.freeze({
      schema_version: CLAUDE_READINESS_SCHEMA,
      provider_id: CLAUDE_PROVIDER_ID,
      state: "BLOCKED_CREDENTIAL_PROVISIONING",
      adapter_contract: "PROVIDER_NEUTRAL_READY",
      credential_reference_present: false,
      raw_credential_visible: false,
      authenticated_canary: false,
      paid_execution_authorized: false,
      next_gate: "PROVISION_PRIVATE_SECRET_REFERENCE_THEN_AUTH_CANARY",
    });
  }

  return Object.freeze({
    schema_version: CLAUDE_READINESS_SCHEMA,
    provider_id: CLAUDE_PROVIDER_ID,
    state: "CREDENTIAL_REFERENCE_PRESENT_AUTH_UNVERIFIED",
    adapter_contract: "PROVIDER_NEUTRAL_READY",
    credential_reference_present: true,
    raw_credential_visible: false,
    authenticated_canary: false,
    paid_execution_authorized: false,
    next_gate: "PRIVATE_AUTHENTICATED_ZERO_SIDE_EFFECT_CANARY",
  });
}

export function safeClaudeReadinessReadback(environment = process.env) {
  const result = assessClaudeReadiness(environment);
  return JSON.stringify(result);
}
