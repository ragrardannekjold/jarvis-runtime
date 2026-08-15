import { catalogDiagnostics, loadCatalog } from "../lib/catalog.js";

const catalog = loadCatalog();

export default function handler(_request, response) {
  response.status(200).json({
    service: "jarvis-utility-search",
    status: "ok",
    transport: "streamable-http",
    mcp: "/mcp",
    catalog: "sanitized-public-fallback",
    zero_incremental_cost: true,
    policy_aware_safe_reroute: true,
    ...catalogDiagnostics(catalog),
  });
}
