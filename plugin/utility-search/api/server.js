import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { getUtility, loadCatalog, resolveLaunchWithFallback, searchCatalog } from "../lib/catalog.js";

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
      fallback_ids: utility.fallback_ids ?? [],
      launch_kind: utility.launch.kind,
      launch_target: utility.launch.target,
      launch_tool: utility.launch.tool ?? null,
    },
  };
}

const handler = createMcpHandler((server) => {
  server.tool(
    "search",
    "Use this when the user wants to find a utility, plugin, tool, or capability by goal or task.",
    { query: z.string().min(1).max(500) },
    async ({ query }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: searchCatalog(catalog, query).map(canonicalSearchResult),
          }),
        },
      ],
    }),
  );

  server.tool(
    "fetch",
    "Use this when the model has a utility id from search and needs its exact capabilities and launch metadata.",
    { id: z.string().min(1).max(128) },
    async ({ id }) => {
      const utility = getUtility(catalog, id);
      if (!utility || utility.visibility !== "plugin") {
        return {
          content: [{ type: "text", text: JSON.stringify({ id, error: "not_found" }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(fetchedUtility(utility)) }],
      };
    },
  );

  server.tool(
    "prepare_launch",
    "Use this when a utility id has been selected and a zero-cost-gated invocation descriptor is required. An explicitly configured connected fallback may be returned when the primary surface is unavailable.",
    { id: z.string().min(1).max(128) },
    async ({ id }) => {
      const result = resolveLaunchWithFallback(catalog, id);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
