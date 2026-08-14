import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { catalogDiagnostics, getUtility, loadCatalog, resolveLaunch, searchCatalog } from "./lib/catalog.js";

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
      launch_kind: utility.launch.kind,
      launch_target: utility.launch.target,
      launch_tool: utility.launch.tool ?? null,
    },
  };
}

export function createUtilitySearchServer() {
  const server = new McpServer(
    { name: "jarvis-utility-search", version: "0.1.0" },
    {
      instructions:
        "Search the utility catalog first. Only plugin-visible, enabled utilities with zero incremental cost are launchable. Prefer structured MCP/plugin interfaces when relevance is otherwise comparable. Use fetch for details and prepare_launch before selecting a target.",
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
      description: "Use this when a utility id has been selected and ChatGPT needs a zero-cost-gated invocation descriptor for the next tool or plugin call.",
      inputSchema: { id: z.string().min(1).max(128) },
      outputSchema: {
        ok: z.boolean(),
        reason: z.string().optional(),
        id: z.string(),
        name: z.string().optional(),
        launch: z.record(z.any()).optional(),
        risk: z.record(z.any()).optional(),
        cost: z.record(z.any()).optional(),
        url: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ id }) => {
      const result = resolveLaunch(catalog, id);
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
