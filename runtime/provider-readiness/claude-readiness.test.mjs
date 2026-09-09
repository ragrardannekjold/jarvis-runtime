import test from "node:test";
import assert from "node:assert/strict";

import {
  assessClaudeReadiness,
  safeClaudeReadinessReadback,
} from "./claude-readiness.mjs";

test("missing credential reference is a truthful blocker, not READY", () => {
  const result = assessClaudeReadiness({});
  assert.equal(result.state, "BLOCKED_CREDENTIAL_AND_ADAPTER_PROVISIONING");
  assert.equal(result.adapter_contract, "READINESS_SCHEMA_ONLY");
  assert.equal(result.provider_adapter_implemented, false);
  assert.equal(result.network_call_executed, false);
  assert.equal(result.model_response_received, false);
  assert.equal(result.authenticated_canary, false);
  assert.equal(result.private_payloads_allowed, false);
  assert.equal(result.data_residency_verified, false);
  assert.equal(result.paid_execution_authorized, false);
});

test("public readiness lane rejects raw provider credentials", () => {
  const result = assessClaudeReadiness({
    ANTHROPIC_API_KEY: "secret-value-that-must-never-be-rendered",
    CLAUDE_API_KEY_REF: "secret://providers/claude/api-key",
  });
  assert.equal(result.state, "REJECTED_RAW_CREDENTIAL_EXPOSURE");
  assert.equal(result.raw_credential_visible, true);
  const rendered = safeClaudeReadinessReadback({
    ANTHROPIC_API_KEY: "secret-value-that-must-never-be-rendered",
    CLAUDE_API_KEY_REF: "secret://providers/claude/api-key",
  });
  assert.equal(rendered.includes("secret-value-that-must-never-be-rendered"), false);
  assert.equal(rendered.includes("secret://providers/claude/api-key"), false);
});

test("credential reference alone does not invent a provider adapter or auth", () => {
  const result = assessClaudeReadiness({
    CLAUDE_API_KEY_REF: "secret://providers/claude/api-key",
  });
  assert.equal(result.state, "CREDENTIAL_REFERENCE_PRESENT_ADAPTER_MISSING");
  assert.equal(result.credential_reference_present, true);
  assert.equal(result.raw_credential_visible, false);
  assert.equal(result.provider_adapter_implemented, false);
  assert.equal(result.network_call_executed, false);
  assert.equal(result.model_response_received, false);
  assert.equal(result.authenticated_canary, false);
  assert.equal(result.next_gate, "IMPLEMENT_PRIVATE_PROVIDER_ADAPTER_THEN_AUTH_CANARY");
});

test("sanitized output never prints a raw credential or its reference", () => {
  const rendered = safeClaudeReadinessReadback({
    ANTHROPIC_API_KEY: "do-not-print-this",
    CLAUDE_API_KEY_REF: "secret://do-not-print-this-reference",
  });
  assert.equal(rendered.includes("do-not-print-this"), false);
  assert.equal(rendered.includes("secret://"), false);
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.state, "REJECTED_RAW_CREDENTIAL_EXPOSURE");
  assert.equal(parsed.network_call_executed, false);
});
