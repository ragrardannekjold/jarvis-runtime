const RAW_KEY_NAMES = Object.freeze(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]);

export const CLAUDE_PROVIDER_ID = "anthropic.claude";
export const CLAUDE_READINESS_SCHEMA = 2;

function commonReadback() {
  return {
    schema_version: CLAUDE_READINESS_SCHEMA,
    provider_id: CLAUDE_PROVIDER_ID,
    adapter_contract: "READINESS_SCHEMA_ONLY",
    provider_adapter_implemented: false,
    network_call_executed: false,
    model_response_received: false,
    authenticated_canary: false,
    private_payloads_allowed: false,
    data_residency_verified: false,
    paid_execution_authorized: false,
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function assessClaudeReadiness(environment = process.env) {
  const rawCredentialVisible = RAW_KEY_NAMES.some((name) => nonEmptyString(environment[name]));
  const credentialRefPresent = nonEmptyString(environment.CLAUDE_API_KEY_REF);

  if (rawCredentialVisible) {
    return Object.freeze({
      ...commonReadback(),
      state: "REJECTED_RAW_CREDENTIAL_EXPOSURE",
      credential_reference_present: credentialRefPresent,
      raw_credential_visible: true,
      next_gate: "MOVE_SECRET_TO_PRIVATE_REFERENCE_RESOLVER",
    });
  }

  if (!credentialRefPresent) {
    return Object.freeze({
      ...commonReadback(),
      state: "BLOCKED_CREDENTIAL_AND_ADAPTER_PROVISIONING",
      credential_reference_present: false,
      raw_credential_visible: false,
      next_gate: "BUILD_PRIVATE_ADAPTER_AND_PROVISION_SECRET_REFERENCE_THEN_AUTH_CANARY",
    });
  }

  return Object.freeze({
    ...commonReadback(),
    state: "CREDENTIAL_REFERENCE_PRESENT_ADAPTER_MISSING",
    credential_reference_present: true,
    raw_credential_visible: false,
    next_gate: "IMPLEMENT_PRIVATE_PROVIDER_ADAPTER_THEN_AUTH_CANARY",
  });
}

export function safeClaudeReadinessReadback(environment = process.env) {
  const result = assessClaudeReadiness(environment);
  return JSON.stringify(result);
}
