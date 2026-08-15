import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { getUtility, loadCatalog, searchCatalog } from "../lib/catalog.js";
import {
  EXECUTION_CONTEXTS,
  prepareContextAwareLaunch,
} from "../lib/context-router.js";
import { RESTRICTED_CAPABILITY_CLASSES } from "../lib/policy-router.js";

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

export function prepareApiLaunch({ id, objective, restricted_capability_class, execution_context }) {
  return prepareContextAwareLaunch(catalog, {
    id,
    objective,
    restricted_capability_class,
    execution_context,
  });
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
    "Use this after selecting a utility. Policy-aware preflight always runs. Pass execution_context=noninteractive for scheduled/background work so interactive-only or unknown-context routes fail closed or use a verified compatible fallback without being misclassified as global outages.",
    {
      id: z.string().min(1).max(128),
      objective: z.string().max(1000).optional(),
      restricted_capability_class: z.enum([...RESTRICTED_CAPABILITY_CLASSES]).optional(),
      execution_context: z.enum([...EXECUTION_CONTEXTS]).optional(),
    },
    async ({ id, objective, restricted_capability_class, execution_context }) => {
      const result = prepareApiLaunch({
        id,
        objective,
        restricted_capability_class,
        execution_context,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };