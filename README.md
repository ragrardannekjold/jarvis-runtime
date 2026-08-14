# JARVIS Public Runtime

This repository is the **sanitized execution shell** for the private canonical command center. It contains no private project data, client data, checkpoints, research, payment records, result ledgers, coordinates, credentials or private history.

## Authority

The private repository `ragrardannekjold/jarvis-command-center@main` is the only canonical control plane. Public workflows are executors, safety paths or self-tests; they do not become parallel orchestrators.

Every public workflow must have an exact binding in the private `config/module_registry.json`. Unknown workflows fail closed. The complete public allowlist is `PUBLIC_EXPORT_MANIFEST.json`.

## Active runtime paths

- `command-center-runtime.yml` — validates private contracts, applies the module switch, executes the bounded allowlisted local executors, writes the private heartbeat and recovery snapshot.
- `kyiv-fast-watch.yml` — separate safety-critical fast path with deduplication and private state.
- `main-daily-report.yml` — creates at most one evidence-first private `main` report per Kyiv local date, with fallback scheduling and readback.
- `relay-a7.yml` — bounded A7 execution to a private state branch.
- `runtime-self-test.yml` — public runtime regression checks.
- `utility-search-self-test.yml` — SHADOW-only validation; it does not admit the search adapter to production routing.

The last verified pre-candidate runtime heartbeat on 2026-08-14 was `PASS`, and both registered local executors returned `PASS`. This is technical runtime evidence only. Credited spendable revenue remains zero until direct payment evidence exists.

## Removed paths

The failed legacy Liski bridge, the one-off checkpoint-parser workflow that pushed directly to private `main`, and the redundant standalone scheduler probe are removed from active runtime. Their paths are forbidden by the private registry and checked on every canonical runtime cycle.

## Security boundary

- Workflows receiving bridge secrets must not use `pull_request` or `pull_request_target`.
- Private checkouts, `/tmp` runtime state and report inputs must not be uploaded as public artifacts.
- Private command output must remain captured or suppressed.
- `COMMAND_CENTER_TOKEN` should be fine-grained and limited to the private command-center repository and required branches.
- External pull requests never receive bridge secrets.
- Runtime state and daily reports remain on private branches.
- A public workflow may not push directly to private `main`.

## Daily report boundary

The system guarantees a durable private report with readback, not an unsolicited ChatGPT message or an unverified Google Drive write. The requested logical chat name is `main`; the available backend does not control the visible ChatGPT title or pin state.

## Deployment truth

Changes on a feature branch are candidates. Production status requires merge to `main`, successful public self-tests, runtime canary and private readback. A green workflow proves only the workflow surface it tested.
