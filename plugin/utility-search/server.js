import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  catalogDiagnostics,
  getUtility,
  loadCatalog,
  searchCatalog,
} from "./lib/catalog.js";
import { EXECUTION_CONTEXTS } from "./lib/context-router.js";
import { prepareLaunchWithFeedback } from "./lib/feedback-router.js";
import { RESTRICTED_CAPABILITY_CLASSES } from "./lib/policy-router.js";

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";
const catalog = loadCatalog();

function canonicalSearchResult(utility) {
  return { id: utility.id, title: utility.name, url: utility.url };
}

function fetchedUtility(utility) {
  return {
    id: utility.id,
    title: utility.name,
    text: utility.description,
    url: utility.url,
    metadata: {
      aliases: utility.aliases,
      intents: utility.intents,
      capabilities: utility.capabilities,
      cost: utility.cost,
      risk: utility.risk,
      status: utility.status,
      execution_context: utility.execution_context ?? null,
      fallback_ids: utility.fallback_ids ?? [],
      launch_kind: utility.launch.kind,
      launch_target: utility.launch.target,
      launch_tool: utility.launch.tool ?? null,
    },
  };
}

export function createUtilitySearchServer() {
  const server = new McpServer(
    { name: "jarvis-utility-search", version: "0.3.0" },
    {
      instructions:
        "Search the utility catalog first. Only plugin-visible, enabled utilities with zero incremental cost are launchable. Prefer structured MCP/plugin interfaces when relevance is otherwise comparable. Use fetch for details and prepare_launch before selecting a target. prepare_launch always runs policy-aware preflight and can also enforce execution-context compatibility. For scheduled/non-interactive work, pass execution_context=noninteractive so interactive-only or unknown-context routes fail closed or fall through to a verified compatible fallback without being misclassified as global outages. After a live connector/API readback failure, pass its provider failure_domain in failed_failure_domains; prepare_launch will suppress that domain and deterministically select the next configured independent domain. Restricted techniques are safely rerouted without retrying the restricted route.",
    }
  );

  server.registerTool(
    "search",
    {
      title: "Search utilities",
      description: "Use this when the user wants to find a utility, plugin, tool, or capability by goal or task.",
      inputSchema: { query: z.string().min(1).max(500) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ query }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ results: searchCatalog(catalog, query).map(canonicalSearchResult) }),
        },
      ],
    })
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch utility",
      description: "Use this when the model has a utility id from search and needs its exact capabilities and launch metadata.",
      inputSchema: { id: z.string().min(1).max(128) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      const utility = getUtility(catalog, id);
      if (!utility || utility.visibility !== "plugin") {
        return { content: [{ type: "text", text: JSON.stringify({ id, error: "not_found" }) }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(fetchedUtility(utility)) }] };
    }
  );

  server.registerTool(
    "prepare_launch",
    {
      title: "Prepare utility launch",
      description: "Use this when a utility id has been selected and ChatGPT needs a zero-cost-gated invocation descriptor. Policy-aware preflight always runs. Pass execution_context=noninteractive for scheduled/background work. After a live adapter failure, pass the failed provider domain in failed_failure_domains so that domain is suppressed and the next configured independent failure domain is selected without a false global outage.",
      inputSchema: {
        id: z.string().min(1).max(128),
        objective: z.string().max(1000).optional(),
        restricted_capability_class: z.enum([...RESTRICTED_CAPABILITY_CLASSES]).optional(),
        execution_context: z.enum([...EXECUTION_CONTEXTS]).optional(),
        failed_failure_domains: z.array(z.string().min(1).max(128)).max(16).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        reason: z.string().optional(),
        id: z.string(),
        requested_id: z.string().optional(),
        fallback_used: z.boolean().optional(),
        primary_reason: z.string().nullable().optional(),
        name: z.string().optional(),
        launch: z.record(z.any()).optional(),
        risk: z.record(z.any()).optional(),
        cost: z.record(z.any()).optional(),
        url: z.string().optional(),
        attempted: z.array(z.record(z.any())).optional(),
        selected_safe_id: z.string().optional(),
        policy_route_rewritten: z.boolean().optional(),
        policy_risk_inferred: z.boolean().optional(),
        restricted_capability_class: z.string().optional(),
        objective: z.string().optional(),
        safe_substitute: z.string().nullable().optional(),
        restricted_route_not_retried: z.boolean().optional(),
        execution_context: z.string().optional(),
        context_state: z.string().optional(),
        context_reroute_used: z.boolean().optional(),
        data_access_started: z.boolean().optional(),
        failed_failure_domains: z.array(z.string()).optional(),
        feedback_reroute_used: z.boolean().optional(),
        feedback_attempted: z.array(z.record(z.any())).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ id, objective, restricted_capability_class, execution_context, failed_failure_domains }) => {
      const result = prepareLaunchWithFeedback(catalog, {
        id,
        objective,
        restricted_capability_class,
        execution_context,
        failed_failure_domains,
      });
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        service: "jarvis-utility-search",
        status: "ok",
        mcp: MCP_PATH,
        zero_incremental_cost: true,
        policy_aware_safe_reroute: true,
        execution_context_aware: true,
        ...catalogDiagnostics(catalog),
      })
    );
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = createUtilitySearchServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed", error instanceof Error ? error.message : error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Jarvis Utility Search MCP listening on http://localhost:${port}${MCP_PATH}`);
});