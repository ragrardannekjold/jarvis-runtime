# Claude -> Outsource MCP canary

Status: branch-only canary; not production and not connected to Claude yet.

## Purpose
Expose a minimal, non-tactical, public-only MCP surface over the existing `public_outsource_worker` runtime so an actual Claude client can prove end-to-end access to the outsource engine without receiving secrets, arbitrary network access, private data, worker administration, or canonical-write authority.

## Tools
- `outsource_capabilities` — lists the actual `CapabilityRegistry` entries.
- `outsource_health` — proves only that the current request path is alive; it does not claim background liveness.
- `outsource_dispatch_canary` — executes the existing real `cuckoo:prozorro_snapshot_v1` -> `bubo:evidence_packet_v1` chain against one fixed official Prozorro fixture.

The dispatch canary is deliberately fixed-input. It cannot select arbitrary URLs or records. The returned BUBO result remains candidate-only and `PENDING_VERIFIER`.

## Safety/truth boundary
This gateway does NOT expose:
- canonical writes;
- secret stores/provider credentials;
- private data;
- arbitrary filesystem/network/shell;
- unrestricted dispatch;
- tactical/current military information.

`tool success != canonical truth`.

## Deployment target
Deploy the repository root as a Vercel project. The MCP endpoint will be:

`https://<deployment>/api/mcp`

Health readback:

`https://<deployment>/api/health`

The current connected Vercel account has no projects, so deployment remains a separate gate until a project is created/imported.

## Claude connection
After a verified HTTPS deployment exists:
1. Claude -> Customize -> Connectors -> Add custom connector.
2. MCP URL: `https://<deployment>/api/mcp`.
3. Run `outsource_capabilities`.
4. Run `outsource_health`.
5. Run `outsource_dispatch_canary` with a stable `run_id`.
6. Preserve the terminal response as the canary receipt.

Do not call the system `CLAUDE_OUTSOURCE_CONNECTED` until an actual Claude client successfully lists the tools and executes the fixed canary.

## Promotion path
After this canary passes:
`PUBLIC_FIXED_CANARY -> AUTHENTICATED READ -> SCOPED SAFE DISPATCH -> DURABLE RECEIPTS -> PRIVATE CAPABILITIES (case-by-case)`.

Production expansion must add scoped OAuth/authorization and keep Research mode read-only by default.
