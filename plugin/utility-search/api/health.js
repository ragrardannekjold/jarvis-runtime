import { loadCatalog } from "../lib/catalog.js";

const catalog = loadCatalog();

export default function handler(_request, response) {
  response.status(200).json({
    service: "jarvis-utility-search",
    status: "ok",
    transport: "streamable-http",
    mcp: "/mcp",
    catalog: "sanitized-public-fallback",
    utility_count: catalog.utilities.length,
    zero_incremental_cost: true,
  });
}
