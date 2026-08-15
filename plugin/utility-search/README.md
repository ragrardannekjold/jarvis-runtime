# Jarvis Utility Search Plugin

Tool-only MCP server for finding an appropriate utility/plugin and returning a zero-incremental-cost launch descriptor.

## Contracts

- `search(query)` — OpenAI-compatible read-only search tool. Returns one text content item containing JSON `{ "results": [{"id","title","url"}] }`.
- `fetch(id)` — OpenAI-compatible read-only fetch tool. Returns one text content item containing JSON `{ "id", "title", "text", "url", "metadata" }`.
- `prepare_launch(id, objective?, restricted_capability_class?)` — returns a launch descriptor after cost/visibility/health gates. When a requested technique is in a bounded restricted class, the caller may provide the legitimate objective and class; the router suppresses the restricted route and selects a configured lawful safe substitute when one can materially preserve the objective.

Policy-aware routing is a **method substitution**, not a policy bypass. The runtime does not obfuscate, disguise, or retry a restricted technique. Current bounded classes include exploitation, active third-party scanning, bypass, credential abuse, payload delivery, unauthorized access, and harmful exact tactical detail. Cyber classes reroute to passive public-source OSINT/CYBINT; harmful exact/tactical detail reroutes to aggregate non-actionable defensive analysis. If no safe substitute mapping exists, the resolver fails closed.

The plugin never executes a paid action itself. A result with cost class `metered`, `paid`, or `unknown`, or `max_usd_per_run > 0`, is blocked by design.

## Catalog boundary

The public runtime contains only a sanitized plugin-visible fallback catalog. This lets the service start without secrets and makes serverless deployment deterministic.

The private command center remains authoritative. A private or larger catalog can override the fallback at runtime:

```bash
export UTILITY_CATALOG_PATH=/path/to/jarvis-command-center/registry/utility_registry.v1.json
# or
export UTILITY_CATALOG_JSON='{"schema_version":1,"utilities":[]}'
```

Only catalog entries with `visibility: "plugin"` are exposed by `search` and `fetch`.

## Local run

```bash
npm install
npm start
```

Optional private-catalog test:

```bash
UTILITY_CATALOG_PATH=tests/fixtures/catalog.json npm start
```

Health endpoint: `http://localhost:8787/`
MCP endpoint: `http://localhost:8787/mcp`

Run checks:

```bash
npm run check
```

The checks include policy-aware resolver tests, local MCP protocol smoke tests, Vercel-handler loading, and direct parity tests for the Vercel `prepare_launch` path.

## Vercel deployment

Use `plugin/utility-search` as the Vercel project root. The included `vercel.json` exposes:

- `/` and `/health` — read-only health JSON;
- `/mcp` — stateless Streamable HTTP MCP endpoint.

The Vercel package uses the sanitized public catalog by default and requires no API key, database, paid model, cron, or always-on process. GitHub remains the source of truth; Vercel is only the HTTPS execution surface.

A deployment is not considered healthy until an external `/health` request and an MCP initialize/tool call both succeed. Local/CI success is not external deployment proof.
