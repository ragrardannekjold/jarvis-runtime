import test from "node:test";
import assert from "node:assert/strict";

import {
  assessClaudeReadiness,
  safeClaudeReadinessReadback,
} from "./claude-readiness.mjs";

test("missing credential reference is a truthful blocker, not READY", () => {
  const result = assessClaudeReadiness({});
  assert.equal(result.state, "BLOCKED_CREDENTIAL_PROVISIONING");
  assert.equal(result.adapter_contract, "PROVIDER_NEUTRAL_READY");
  assert.equal(result.authenticated_canary, false);
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

test("credential reference alone advances only to auth-unverified", () => {
  const result = assessClaudeReadiness({
    CLAUDE_API_KEY_REF: "secret://providers/claude/api-key",
  });
  assert.equal(result.state, "CREDENTIAL_REFERENCE_PRESENT_AUTH_UNVERIFIED");
  assert.equal(result.credential_reference_present, true);
  assert.equal(result.raw_credential_visible, false);
  assert.equal(result.authenticated_canary, false);
  assert.equal(result.next_gate, "PRIVATE_AUTHENTICATED_ZERO_SIDE_EFFECT_CANARY");
});
