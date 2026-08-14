import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  catalogDiagnostics,
  loadCatalog,
  resolveLaunch,
  resolveLaunchWithFallback,
  scoreUtility,
  searchCatalog,
  validateCatalog,
} from "../lib/catalog.js";

const catalog = validateCatalog(JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8")));

test("search ranks a matching zero-cost utility", () => {
  const results = searchCatalog(catalog, "github repository");
  assert.equal(results[0].id, "github.repo_ops");
});

test("metered utility is excluded from search", () => {
  const results = searchCatalog(catalog, "paid example");
  assert.equal(results.some((item) => item.id === "metered.example"), false);
});

test("zero-cost gate blocks metered launch", () => {
  assert.deepEqual(resolveLaunch(catalog, "metered.example"), {
    ok: false,
    id: "metered.example",
    reason: "zero_cost_gate",
    cost: { class: "metered", max_usd_per_run: 0.01 },
  });
});

test("fallback resolver can route a blocked primary to a safe connected utility", () => {
  const result = resolveLaunchWithFallback(catalog, "metered.example");
  assert.equal(result.ok, true);
  assert.equal(result.requested_id, "metered.example");
  assert.equal(result.fallback_used, true);
  assert.equal(result.primary_reason, "zero_cost_gate");
  assert.equal(result.id, "github.repo_ops");
});

test("zero-cost gate permits included plugin utility", () => {
  const result = resolveLaunch(catalog, "github.repo_ops");
  assert.equal(result.ok, true);
  assert.equal(result.launch.target, "GitHub");
});

test("server can boot from the bundled public catalog without secrets", () => {
  const bundled = loadCatalog({});
  assert.ok(bundled.utilities.length >= 5);
  assert.equal(searchCatalog(bundled, "openai plugin")[0].id, "openai.developers");
});

test("bundled Utility Search is not launchable before external deployment proof", () => {
  const bundled = loadCatalog({});
  assert.deepEqual(resolveLaunch(bundled, "jarvis.utility_search"), {
    ok: false,
    id: "jarvis.utility_search",
    reason: "disabled",
  });
});

test("bundled Utility Search has an independent connected fallback path", () => {
  const bundled = loadCatalog({});
  const result = resolveLaunchWithFallback(bundled, "jarvis.utility_search");
  assert.equal(result.ok, true);
  assert.equal(result.requested_id, "jarvis.utility_search");
  assert.equal(result.fallback_used, true);
  assert.equal(result.primary_reason, "disabled");
  assert.equal(result.id, "google_drive.search");
  assert.equal(result.launch.target, "Google Drive");
});

test("catalog rejects a healthy MCP claim without complete external evidence", () => {
  const candidate = structuredClone(loadCatalog({}));
  const utility = candidate.utilities.find((item) => item.id === "jarvis.utility_search");
  utility.status = { enabled: true, health: "healthy" };
  utility.deployment = {
    health_url: "https://utility.example.com/health",
    mcp_url: "https://utility.example.com/mcp",
    verified_at: "2026-08-14T09:15:18Z",
    external_health_verified: true,
    mcp_initialize_verified: true,
    tool_call_verified: false,
    readback_sha256: "a".repeat(64),
    evidence_source: "synthetic"
  };
  assert.throws(() => validateCatalog(candidate), /verified external deployment readback/);
});

test("catalog accepts a healthy MCP claim only with complete external evidence", () => {
  const candidate = structuredClone(loadCatalog({}));
  const utility = candidate.utilities.find((item) => item.id === "jarvis.utility_search");
  utility.status = { enabled: true, health: "healthy" };
  utility.deployment = {
    health_url: "https://utility.example.com/health",
    mcp_url: "https://utility.example.com/mcp",
    verified_at: "2026-08-14T09:15:18Z",
    external_health_verified: true,
    mcp_initialize_verified: true,
    tool_call_verified: true,
    readback_sha256: "b".repeat(64),
    evidence_source: "external-production-canary"
  };
  const validated = validateCatalog(candidate);
  assert.equal(resolveLaunch(validated, "jarvis.utility_search").ok, true);
});

test("catalog rejects unknown fallback ids", () => {
  const candidate = structuredClone(loadCatalog({}));
  candidate.utilities[0].fallback_ids = ["missing.utility"];
  assert.throws(() => validateCatalog(candidate), /unknown fallback id/);
});

test("catalog rejects fallback cycles", () => {
  const candidate = structuredClone(loadCatalog({}));
  candidate.utilities.find((item) => item.id === "google_drive.search").fallback_ids = ["jarvis.utility_search"];
  assert.throws(() => validateCatalog(candidate), /Fallback cycle/);
});

test("catalog updated_at must be timezone-aware", () => {
  const candidate = structuredClone(loadCatalog({}));
  candidate.updated_at = "2026-08-14T09:25:00";
  assert.throws(() => validateCatalog(candidate), /timezone-aware/);
});

test("diagnostics expose catalog freshness and launchable counts", () => {
  const bundled = loadCatalog({});
  const diagnostics = catalogDiagnostics(bundled, new Date("2026-08-15T01:00:00Z"));
  assert.equal(diagnostics.catalog_updated_at, "2026-08-15T00:00:00Z");
  assert.equal(diagnostics.catalog_age_seconds, 3600);
  assert.equal(diagnostics.utility_count, bundled.utilities.length);
  assert.equal(diagnostics.launchable_utility_count, 4);
  assert.equal(diagnostics.not_deployed_utility_count, 1);
});

test("structured connected tool wins an otherwise equivalent routing tie", () => {
  const base = {
    id: "example.base",
    name: "Example Utility",
    description: "shared exact task",
    url: "https://example.com/",
    aliases: ["shared exact task"],
    intents: ["shared exact task"],
    capabilities: ["shared exact task"],
    cost: { class: "included", max_usd_per_run: 0 },
    risk: { mode: "read_only", confirmation_required: false },
    status: { enabled: true, health: "healthy" },
    visibility: "plugin",
    priority: 50,
  };
  const plugin = { ...structuredClone(base), id: "example.plugin", launch: { kind: "chat_plugin", target: "Plugin" } };
  const capability = {
    ...structuredClone(base),
    id: "example.capability",
    launch: { kind: "chat_capability", target: "Capability" },
  };
  assert.ok(scoreUtility(plugin, "shared exact task") > scoreUtility(capability, "shared exact task"));
});
