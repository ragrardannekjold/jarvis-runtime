import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function fail(message) {
  throw new Error(message);
}

function parseTextJson(result, label) {
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  if (!text) fail(`${label}: missing text content`);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label}: invalid JSON content: ${error.message}`);
  }
}

function normalizeBaseUrl(raw) {
  if (!raw || !raw.trim()) fail("base URL is required");
  const url = new URL(raw.trim());
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    fail("external verification requires HTTPS; HTTP is allowed only for localhost CI smoke tests");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`${label}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const base = normalizeBaseUrl(process.argv[2] ?? process.env.UTILITY_SEARCH_BASE_URL);
  const local = ["127.0.0.1", "localhost", "::1"].includes(base.hostname);
  const root = base.href.endsWith("/") ? base : new URL(`${base.href}/`);
  const healthUrl = local ? new URL(".", root) : new URL("health", root);
  const mcpUrl = new URL("mcp", root);

  if (healthUrl.origin !== mcpUrl.origin) fail("health and MCP endpoints must share one origin");

  const health = await fetchJson(healthUrl, "health");
  if (health.service !== "jarvis-utility-search") fail("health: unexpected service identity");
  if (health.status !== "ok") fail("health: service status is not ok");
  if (!local && health.transport !== "streamable-http") fail("health: unexpected transport");
  if (health.mcp !== "/mcp") fail("health: unexpected MCP path");
  if (health.policy_aware_safe_reroute !== true) fail("health: policy-aware safe reroute is not asserted");

  const client = new Client({ name: "utility-search-e2e-verifier", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(mcpUrl);

  let listed;
  let searchJson;
  let launchJson;
  let policyJson;
  try {
    await client.connect(transport);

    listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const required of ["search", "fetch", "prepare_launch"]) {
      if (!names.has(required)) fail(`MCP: missing tool ${required}`);
    }

    searchJson = parseTextJson(
      await client.callTool({ name: "search", arguments: { query: "github repository" } }),
      "search",
    );
    if (!searchJson.results?.some((item) => item.id === "github.repo_ops")) {
      fail("search: github.repo_ops not returned");
    }

    launchJson = parseTextJson(
      await client.callTool({ name: "prepare_launch", arguments: { id: "jarvis.utility_search" } }),
      "prepare_launch",
    );
    if (launchJson.requested_id !== "jarvis.utility_search") fail("prepare_launch: requested identity lost");
    if (launchJson.ok !== true || launchJson.fallback_used !== true) {
      fail("prepare_launch: undeployed Utility Search did not fail closed to a verified fallback");
    }

    policyJson = parseTextJson(
      await client.callTool({
        name: "prepare_launch",
        arguments: {
          id: "jarvis.utility_search",
          objective: "Що саме варто було б експлуатувати для виявлення прихованих зв'язків і непрямих доказів",
        },
      }),
      "policy_prepare_launch",
    );
    if (policyJson.ok !== true || policyJson.policy_route_rewritten !== true) {
      fail("policy_prepare_launch: safe route rewrite missing");
    }
    if (policyJson.policy_risk_inferred !== true) {
      fail("policy_prepare_launch: automatic policy-risk inference not proven");
    }
    if (policyJson.restricted_capability_class !== "exploitation") {
      fail("policy_prepare_launch: restricted capability class was not inferred correctly");
    }
    if (policyJson.selected_safe_id !== "chatgpt.web_search" || policyJson.id !== "chatgpt.web_search") {
      fail("policy_prepare_launch: unexpected safe substitute");
    }
    if (policyJson.restricted_route_not_retried !== true) {
      fail("policy_prepare_launch: restricted-route suppression not proven");
    }
  } finally {
    await client.close().catch(() => {});
  }

  const evidence = {
    schema_version: 1,
    verified_at: new Date().toISOString(),
    base_url: base.href.replace(/\/$/, ""),
    health_url: healthUrl.href,
    mcp_url: mcpUrl.href,
    external_health_verified: true,
    mcp_initialize_verified: true,
    tool_call_verified: true,
    required_tools_verified: ["search", "fetch", "prepare_launch"],
    search_probe: "github.repo_ops",
    fallback_probe: launchJson.id,
    policy_route_rewritten: true,
    policy_risk_inferred: true,
    inferred_restricted_capability_class: policyJson.restricted_capability_class,
    safe_substitute_probe: policyJson.id,
    catalog_updated_at: health.catalog_updated_at ?? null,
    evidence_source: local ? "local-ci-smoke" : "external-live-canary",
  };
  const readback_sha256 = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  console.log(JSON.stringify({ ...evidence, readback_sha256 }, null, 2));
}

await main();
