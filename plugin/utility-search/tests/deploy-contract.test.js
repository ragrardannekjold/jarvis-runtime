import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contract = JSON.parse(
  readFileSync(new URL("../deploy-contract.json", import.meta.url), "utf8"),
);
const vercel = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
);

function rewriteDestination(source) {
  return vercel.rewrites.find((item) => item.source === source)?.destination ?? null;
}

test("deployment contract binds a deterministic Vercel target without account secrets", () => {
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.provider, "vercel");
  assert.equal(contract.project_name, "jarvis-utility-search");
  assert.match(contract.project_name, /^[a-z0-9-]+$/);
  assert.equal(contract.source.repository, "ragrardannekjold/jarvis-runtime");
  assert.equal(contract.source.ref, "main");
  assert.equal(contract.source.root_directory, "plugin/utility-search");
  assert.equal(contract.deploy_guard.requires_explicit_project_binding, true);
  assert.equal(contract.deploy_guard.blind_zero_argument_deploy_forbidden, true);
  assert.equal(contract.deploy_guard.zero_incremental_cost_required, true);
  assert.equal(contract.operational_state, "NOT_DEPLOYED_UNTIL_EXTERNAL_READBACK");
  for (const forbidden of ["token", "secret", "team_id", "project_id", "deployment_url"]) {
    assert.equal(Object.hasOwn(contract, forbidden), false, `contract must not persist ${forbidden}`);
  }
});

test("deployment contract endpoint expectations match Vercel rewrites", () => {
  assert.equal(contract.expected_endpoints.health, "/health");
  assert.equal(contract.expected_endpoints.mcp, "/mcp");
  assert.equal(rewriteDestination(contract.expected_endpoints.health), "/api/health");
  assert.equal(rewriteDestination(contract.expected_endpoints.mcp), "/api/server");
});

test("deployment contract requires the canonical external E2E proof chain", () => {
  assert.equal(contract.verification.workflow, ".github/workflows/utility-search-external-e2e.yml");
  assert.equal(contract.verification.verifier, "plugin/utility-search/scripts/verify-external-e2e.mjs");
  assert.equal(contract.verification.evidence_source, "external-live-canary");
  assert.deepEqual(
    new Set(contract.verification.required_readback),
    new Set([
      "external_health_verified",
      "mcp_initialize_verified",
      "tool_call_verified",
      "readback_sha256",
    ]),
  );
});
