# Jarvis Utility Search Plugin

Tool-only MCP server for finding an appropriate utility/plugin from the private Jarvis utility catalog and returning a zero-incremental-cost launch descriptor.

## Contracts

- `search(query)` — OpenAI-compatible read-only search tool. Returns one text content item containing JSON `{ "results": [{"id","title","url"}] }`.
- `fetch(id)` — OpenAI-compatible read-only fetch tool. Returns one text content item containing JSON `{ "id", "title", "text", "url", "metadata" }`.
- `prepare_launch(id)` — returns a launch descriptor only after the zero-cost, visibility, enabled-state, and health gates pass.

The plugin never executes a paid action itself. A result with cost class `metered`, `paid`, or `unknown`, or `max_usd_per_run > 0`, is blocked by design.

## Catalog boundary

Production catalog data is intentionally **not stored in this public repository**. Supply it at runtime using one of:

```bash
export UTILITY_CATALOG_PATH=/path/to/jarvis-command-center/registry/utility_registry.v1.json
# or
export UTILITY_CATALOG_JSON='{"schema_version":1,"utilities":[]}'
```

Only catalog entries with `visibility: "plugin"` are exposed by `search`/`fetch`.

## Local run

```bash
npm install
UTILITY_CATALOG_PATH=tests/fixtures/catalog.json npm start
```

Health endpoint: `http://localhost:8787/`
MCP endpoint: `http://localhost:8787/mcp`

Run checks:

```bash
npm run check
```

For ChatGPT developer-mode testing, expose the local MCP endpoint through an HTTPS tunnel and connect the HTTPS `/mcp` URL as a plugin. Production hosting must provide a stable HTTPS `/mcp` endpoint; GitHub remains the source of truth, not the always-on application server.
