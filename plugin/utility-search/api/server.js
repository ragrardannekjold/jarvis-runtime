import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { getUtility, loadCatalog, resolveLaunchWithFallback, searchCatalog } from "../lib/catalog.js";
import {
  preparePolicyAwareLaunch,
  RESTRICTED_CAPABILITY_CLASSES,
} from "../lib/policy-router.js";

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

export function prepareApiLaunch({ id, objective, restricted_capability_class }) {
  if (restricted_capability_class) {
    return preparePolicyAwareLaunch(catalog, {
      id,
      objective,
      restricted_capability_class,
    });
  }
  return {
    ...resolveLaunchWithFallback(catalog, id),
    policy_route_rewritten: false,
    objective:
      typeof objective === "string" && objective.trim()
        ? objective.trim().slice(0, 1000)
        : undefined,
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
    "Use this after selecting a utility. For a restricted requested technique, provide the legitimate objective and restricted_capability_class so the handler safe-reroutes to a lawful substitute without retrying the restricted route.",
    {
      id: z.string().min(1).max(128),
      objective: z.string().max(1000).optional(),
      restricted_capability_class: z.enum([...RESTRICTED_CAPABILITY_CLASSES]).optional(),
    },
    async ({ id, objective, restricted_capability_class }) => {
      const result = prepareApiLaunch({ id, objective, restricted_capability_class });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
