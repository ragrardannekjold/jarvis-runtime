import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const contractUrl = new URL("./activation-contract.json", import.meta.url);

async function loadContract() {
  return JSON.parse(await readFile(contractUrl, "utf8"));
}

test("signed-v2 bridge stays inactive until external attestation", async () => {
  const contract = await loadContract();
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.lane, "SIGNED_V2_PRIVATE_BRIDGE");
  assert.equal(contract.lifecycle_state, "INACTIVE_LIBRARY_ONLY");
  assert.equal(contract.activation_state, "BLOCKED_EXTERNAL_ATTESTATION");
  assert.equal(contract.token_cutover_phase, "CONTAIN");
  assert.equal(contract.credentials_provisioned, "NOT_PROVEN");
  assert.equal(contract.protected_environment_attested, false);
  assert.equal(contract.branch_rules_attested, false);
  assert.equal(contract.approval_policy_attested, false);
  assert.equal(contract.external_authority_artifact, null);
  assert.equal(contract.live_private_bridge_readback, "NOT_PROVEN");
  assert.equal(contract.live_source_watcher, "NOT_PROVEN");
});

test("CONTAIN phase forbids public queue integration and legacy workflow activation", async () => {
  const contract = await loadContract();
  assert.equal(contract.public_continuous_queue_integration, "FORBIDDEN_IN_CONTAIN_PHASE");
  assert.equal(contract.legacy_private_async_bridge, "MUST_REMAIN_TOMBSTONED");
  assert.equal(contract.activation_from_pull_request_ci_allowed, false);
  assert.equal(contract.secrets_in_pull_request_ci_allowed, false);
  assert.equal(contract.requirements.legacy_shared_token_remains_disabled, true);
  assert.equal(contract.requirements.public_continuous_queue_blob_remains_exact_reviewed_baseline, true);
});

test("activation requires distinct short-lived identities and external authority", async () => {
  const contract = await loadContract();
  assert.equal(contract.credential_model, "DISTINCT_SHORT_LIVED_GITHUB_APP_IDENTITIES_REQUIRED");
  assert.equal(contract.requirements.distinct_read_and_write_credential_identities, true);
  assert.equal(contract.requirements.short_lived_or_independently_revocable, true);
  assert.equal(contract.requirements.single_private_repository_scope, "ragrardannekjold/jarvis-command-center");
  assert.equal(contract.requirements.least_contents_permissions, true);
  assert.equal(contract.requirements.no_inherited_secret_context, true);
  assert.equal(contract.requirements.private_child_receives_no_github_token_or_app_key, true);
  assert.equal(contract.requirements.private_stdout_stderr_contained, true);
  assert.equal(contract.requirements.external_attestation_required_before_secret_bearing_execution, true);
  assert.equal(contract.requirements.live_canary_readback_required_before_promotion, true);
});

test("contract distinguishes code proof from runtime proof", async () => {
  const contract = await loadContract();
  const codeProof = new Set(contract.truth_boundary.code_and_contract_tests_can_prove);
  const runtimeProof = new Set(contract.truth_boundary.code_and_contract_tests_cannot_prove);
  assert.ok(codeProof.has("credential_minting_logic"));
  assert.ok(codeProof.has("public_queue_isolation"));
  assert.ok(runtimeProof.has("credential_provisioning"));
  assert.ok(runtimeProof.has("protected_environment_policy"));
  assert.ok(runtimeProof.has("live_private_bridge_execution"));
  assert.ok(runtimeProof.has("permanent_live_watcher"));
});
