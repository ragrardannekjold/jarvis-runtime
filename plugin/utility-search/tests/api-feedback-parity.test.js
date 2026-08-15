import assert from "node:assert/strict";
import test from "node:test";
import { prepareApiLaunch } from "../api/server.js";

test("Vercel prepare_launch preserves failed-domain feedback failover", () => {
  const result = prepareApiLaunch({
    id: "jarvis.utility_search",
    execution_context: "noninteractive",
    failed_failure_domains: ["google"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, "github.repo_ops");
  assert.equal(result.launch.failure_domain, "github");
  assert.equal(result.feedback_reroute_used, true);
  assert.deepEqual(result.failed_failure_domains, ["google"]);
});

test("Vercel prepare_launch reaches the third independent domain after two failures", () => {
  const result = prepareApiLaunch({
    id: "jarvis.utility_search",
    execution_context: "noninteractive",
    failed_failure_domains: ["google", "github"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, "chatgpt.web_search");
  assert.equal(result.launch.failure_domain, "openai");
  assert.equal(result.feedback_reroute_used, true);
});

test("Vercel prepare_launch exhausts failed domains locally rather than claiming a global outage", () => {
  const result = prepareApiLaunch({
    id: "jarvis.utility_search",
    execution_context: "noninteractive",
    failed_failure_domains: ["google", "github", "openai"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failure_domains_exhausted");
  assert.notEqual(result.reason, "global_unavailable");
  assert.equal(result.data_access_started, false);
});
