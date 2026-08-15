import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog, resolveLaunch, resolveLaunchWithFallback } from "../lib/catalog.js";

test("external adapter launch requires live readback before first data access", () => {
  const catalog = loadCatalog({});
  const result = resolveLaunch(catalog, "github.repo_ops");

  assert.equal(result.ok, true);
  assert.equal(result.launch.failure_domain, "github");
  assert.equal(result.launch.failure_scope, "external");
  assert.equal(result.launch.pre_execution_readback.required, true);
  assert.equal(result.launch.pre_execution_readback.timing, "immediately_before_first_data_access");
  assert.equal(result.launch.pre_execution_readback.static_catalog_health_sufficient, false);
  assert.equal(result.launch.pre_execution_readback.on_failure.adapter_state, "UNKNOWN_OR_DEGRADED");
  assert.equal(result.launch.pre_execution_readback.on_failure.global_state, "UNCHANGED");
  assert.equal(result.launch.pre_execution_readback.on_failure.action, "TRY_NEXT_INDEPENDENT_FAILURE_DOMAIN");
});

test("utility-search fallback descriptor preserves independent provider failover order", () => {
  const catalog = loadCatalog({});
  const result = resolveLaunchWithFallback(catalog, "jarvis.utility_search");

  assert.equal(result.ok, true);
  assert.equal(result.id, "google_drive.search");
  assert.equal(result.fallback_used, true);
  assert.equal(result.launch.pre_execution_readback.failure_domain, "google");
  assert.deepEqual(result.launch.pre_execution_readback.on_failure.candidates, [
    { id: "github.repo_ops", failure_domain: "github" },
    { id: "chatgpt.web_search", failure_domain: "openai" },
  ]);
});

test("same failure domain is never counted twice in a live-readback fallback plan", () => {
  const catalog = loadCatalog({});
  const airtable = catalog.utilities.find((item) => item.id === "airtable.record_search");
  airtable.fallback_ids = ["google_drive.search", "gmail.message_search", "github.repo_ops"];
  const result = resolveLaunchWithFallback(catalog, "airtable.record_search");
  const candidates = result.launch.pre_execution_readback.on_failure.candidates;

  assert.deepEqual(candidates, [
    { id: "google_drive.search", failure_domain: "google" },
    { id: "github.repo_ops", failure_domain: "github" },
  ]);
});

test("internal adapter does not pretend a live external readback exists", () => {
  const catalog = loadCatalog({});
  const utility = catalog.utilities.find((item) => item.id === "jarvis.utility_search");
  utility.status = { enabled: true, health: "healthy" };
  utility.launch = { kind: "chat_capability", target: "Local Utility Search" };
  const result = resolveLaunch(catalog, "jarvis.utility_search");

  assert.equal(result.ok, true);
  assert.equal(result.launch.failure_scope, "internal");
  assert.equal(result.launch.pre_execution_readback, undefined);
});
