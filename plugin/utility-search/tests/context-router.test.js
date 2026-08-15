import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog } from "../lib/catalog.js";
import {
  contextStateForUtility,
  prepareContextAwareLaunch,
} from "../lib/context-router.js";

test("noninteractive launch skips unknown-context fallback and selects verified compatible fallback", () => {
  const catalog = loadCatalog({});
  const result = prepareContextAwareLaunch(catalog, {
    id: "jarvis.utility_search",
    execution_context: "noninteractive",
  });
  assert.equal(result.ok, true);
  assert.equal(result.requested_id, "jarvis.utility_search");
  assert.equal(result.id, "github.repo_ops");
  assert.equal(result.fallback_used, true);
  assert.equal(result.execution_context, "noninteractive");
  assert.equal(result.context_state, "COMPATIBLE_NONINTERACTIVE");
  assert.equal(result.context_reroute_used, true);
  assert.equal(result.data_access_started, false);
  assert.ok(result.attempted.some((item) => item.id === "google_drive.search" && item.reason === "unknown_context"));
});

test("verified Gmail connector is compatible with noninteractive routing", () => {
  const catalog = loadCatalog({});
  const result = prepareContextAwareLaunch(catalog, {
    id: "gmail.message_search",
    execution_context: "noninteractive",
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, "gmail.message_search");
  assert.equal(result.context_state, "COMPATIBLE_NONINTERACTIVE");
  assert.equal(result.context_reroute_used, false);
});

test("unknown noninteractive compatibility is not misreported as global outage", () => {
  const catalog = loadCatalog({});
  const result = prepareContextAwareLaunch(catalog, {
    id: "google_drive.search",
    execution_context: "noninteractive",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_context");
  assert.equal(result.context_state, "UNKNOWN_CONTEXT");
  assert.equal(result.data_access_started, false);
  assert.notEqual(result.reason, "global_unavailable");
});

test("declared interactive-only context fails closed before protected data access", () => {
  const catalog = loadCatalog({});
  const utility = catalog.utilities.find((item) => item.id === "google_drive.search");
  utility.execution_context = { noninteractive: "INTERACTIVE_ONLY_FOR_CONTEXT" };
  assert.equal(contextStateForUtility(utility, "noninteractive"), "INTERACTIVE_ONLY_FOR_CONTEXT");
  const result = prepareContextAwareLaunch(catalog, {
    id: "google_drive.search",
    execution_context: "noninteractive",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "interactive_only_for_context");
  assert.equal(result.context_state, "INTERACTIVE_ONLY_FOR_CONTEXT");
  assert.equal(result.data_access_started, false);
});

test("omitting execution context preserves legacy launch behavior", () => {
  const catalog = loadCatalog({});
  const result = prepareContextAwareLaunch(catalog, { id: "jarvis.utility_search" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "google_drive.search");
  assert.equal(result.fallback_used, true);
  assert.equal(result.execution_context, undefined);
});

test("policy safe reroute remains compatible in noninteractive context", () => {
  const catalog = loadCatalog({});
  const result = prepareContextAwareLaunch(catalog, {
    id: "restricted.exploitation",
    objective: "What should we exploit to reveal hidden relationships?",
    execution_context: "noninteractive",
  });
  assert.equal(result.ok, true);
  assert.equal(result.policy_route_rewritten, true);
  assert.equal(result.policy_risk_inferred, true);
  assert.equal(result.id, "chatgpt.web_search");
  assert.equal(result.context_state, "COMPATIBLE_NONINTERACTIVE");
  assert.equal(result.restricted_route_not_retried, true);
});
