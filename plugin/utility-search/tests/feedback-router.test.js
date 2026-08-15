import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog } from "../lib/catalog.js";
import { prepareLaunchWithFeedback } from "../lib/feedback-router.js";

test("failed Google readback deterministically reroutes Utility Search to GitHub", () => {
  const catalog = loadCatalog({});
  const result = prepareLaunchWithFeedback(catalog, {
    id: "jarvis.utility_search",
    execution_context: "noninteractive",
    failed_failure_domains: ["google"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, "github.repo_ops");
  assert.equal(result.requested_id, "jarvis.utility_search");
  assert.equal(result.fallback_used, true);
  assert.equal(result.feedback_reroute_used, true);
  assert.deepEqual(result.failed_failure_domains, ["google"]);
  assert.equal(result.launch.failure_domain, "github");
  assert.ok(result.feedback_attempted.some((item) => item.failure_domain === "google" && item.ok === false));
});

test("failed Google and GitHub readbacks deterministically reroute Utility Search to OpenAI web search", () => {
  const catalog = loadCatalog({});
  const result = prepareLaunchWithFeedback(catalog, {
    id: "jarvis.utility_search",
    execution_context: "noninteractive",
    failed_failure_domains: ["google", "github"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, "chatgpt.web_search");
  assert.equal(result.launch.failure_domain, "openai");
  assert.equal(result.feedback_reroute_used, true);
  assert.equal(result.data_access_started, false);
});

test("repeated failed domains are normalized and never retried", () => {
  const catalog = loadCatalog({});
  const result = prepareLaunchWithFeedback(catalog, {
    id: "jarvis.utility_search",
    failed_failure_domains: [" Google ", "google", "GOOGLE"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, "github.repo_ops");
  assert.deepEqual(result.failed_failure_domains, ["google"]);
  assert.equal(result.feedback_attempted.filter((item) => item.failure_domain === "google").length, 1);
});

test("all configured external failure domains exhaust locally without a false global outage", () => {
  const catalog = loadCatalog({});
  const result = prepareLaunchWithFeedback(catalog, {
    id: "jarvis.utility_search",
    execution_context: "noninteractive",
    failed_failure_domains: ["google", "github", "openai"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failure_domains_exhausted");
  assert.notEqual(result.reason, "global_unavailable");
  assert.equal(result.data_access_started, false);
  assert.equal(result.feedback_reroute_used, true);
});

test("policy-safe route is never replaced by retrying the restricted route after provider failure", () => {
  const catalog = loadCatalog({});
  const result = prepareLaunchWithFeedback(catalog, {
    id: "restricted.exploitation",
    objective: "Exploit a third-party target to reveal hidden relationships",
    execution_context: "noninteractive",
    failed_failure_domains: ["openai"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "safe_substitute_failure_domains_exhausted");
  assert.equal(result.policy_route_rewritten, true);
  assert.equal(result.restricted_route_not_retried, true);
  assert.equal(result.feedback_attempted.some((item) => item.id === "restricted.exploitation"), false);
});

test("failed-domain feedback does not change a healthy independent selection", () => {
  const catalog = loadCatalog({});
  const result = prepareLaunchWithFeedback(catalog, {
    id: "github.repo_ops",
    execution_context: "noninteractive",
    failed_failure_domains: ["google"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, "github.repo_ops");
  assert.equal(result.feedback_reroute_used, false);
  assert.deepEqual(result.failed_failure_domains, ["google"]);
});
