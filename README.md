# JARVIS Public Runtime

This repository is the **sanitized public runtime** for the private command center. It intentionally contains no project data, client data, checkpoints, research, payment records, result ledgers, coordinates, or private history.

## Purpose

Use standard GitHub-hosted runners in a public repository while keeping the authoritative command center private.

The public runner is designed to:
1. check out this public runtime;
2. use narrowly scoped repository secrets: `COMMAND_CENTER_TOKEN` for the private bridge and provider credentials only inside owner-controlled capability workflows;
3. ephemerally check out the private `ragrardannekjold/jarvis-command-center` repository;
4. run a strict allowlist of control-plane validation/regression commands with private stdout/stderr captured rather than printed;
5. write a minimal heartbeat back to the private `jarvis-runtime-state` branch;
6. upload no private artifacts.

## Security boundary

- Do not add `pull_request` or `pull_request_target` triggers to workflows that receive bridge secrets.
- Do not upload the private checkout or `/tmp/jarvis-public-runtime` as artifacts.
- Do not print private command output.
- Do not copy project files, registry content, checkpoints, research, payment data, geodata, or result records into this public repository.
- `COMMAND_CENTER_TOKEN` should be a fine-grained GitHub token limited to the single private command-center repository and only the permissions required by the runtime.
- External pull requests must never receive bridge secrets.
- `SHODAN_API_KEY` is consumed only by owner-controlled workflows. Credential readback calls `/api-info`; the separate exposure workflow accepts only a private, unexpired, explicitly authorized passive task and never prints its target or provider data.
- The exposure workflow never calls an active-scan endpoint. Each task is capped at one provider page and one Shodan query credit. A pre-dispatch clear failure may route to Censys and then Netlas, but an ambiguous post-dispatch outcome is persisted and blocks automatic retry or provider mixing.
- Runtime state belongs in the private `jarvis-runtime-state` branch.

## Current capability

The secret-free public runner self-test is verified working. The authenticated private bridge remains disabled until `COMMAND_CENTER_TOKEN` is configured and a manual bridge test passes.

The Shodan lane has an independent owner-controlled credential readback at `.github/workflows/shodan-runtime-readback.yml`. Live run [#1](https://github.com/ragrardannekjold/jarvis-runtime/actions/runs/32364522450) verified this runtime can authenticate to Shodan without search or scan execution and with zero query credits spent. The public receipt contains capability booleans only; it does not expose the credential, account plan, or exact balances.

The operational passive lane is `.github/workflows/exposure-intelligence.yml`. It polls a private queue on the `jarvis-runtime-state` branch, writes a fail-closed `STARTED` receipt before any provider request, and then uses Shodan primary with Censys and Netlas standby adapters. Targets, normalized observations, provider events, exact balances, and the hash-chained evidence ledger are written only to the private state branch. Public logs receive a finite status and receipt hash. Repeated schedules do not re-execute a task that already has a receipt, including an interrupted `STARTED` task.

Live runs [#1](https://github.com/ragrardannekjold/jarvis-runtime/actions/runs/32366430482) and [#3](https://github.com/ragrardannekjold/jarvis-runtime/actions/runs/32368379389) verified two separately authorized documentation canaries. Each task used exactly one Shodan query credit; the latest exact-hostname scope retained 41 observations in 42 verified evidence entries. The target, task identifier, observations, IP data, credentials, and exact account balances were absent from public logs. `runtime/exposure-verify-trigger.txt` provides a zero-task commit-triggered route for explicit idempotency readback without waiting for cron.

Knowledge and Skills Bus Core v0.1 lives at `runtime/knowledge-skill-bus/` as a deterministic packet contract and read-only canary. Its public-issue runtime route is quarantined because inline issue bodies are scrapeable; activation requires an authenticated private transport with opaque references, bounded retention, least-privilege credentials, and identity-bound readback.

Historical public-queue canary [issue #278](https://github.com/ragrardannekjold/jarvis-runtime/issues/278) reported a successful deterministic packet readback and the expected `capability_missing: bus.private_transport` gap. That legacy-v1 observation is retained as feature evidence, not accepted as a security attestation; the scrapeable inline route is now quarantined.

Runtime Anomaly Sentinel v0.1 lives at `runtime/anomaly-sentinel/`. It observes GitHub Actions at the source, collapses repeated active failures into one sanitized `[ANOMALY]` issue, and closes the issue after a newer successful run. Expected concurrency cancellations remain distinct from outages. The hourly worker never reads mailbox content and never retries failed workflows.

Phase 1 restores **independent control-plane validation** outside the private repository's billing-blocked GitHub-hosted Actions.

It does **not yet** execute project-native workflows locally. The heartbeat therefore explicitly reports:

`local_project_executor_dispatch = NOT_YET_ENABLED`

That state must not be described as full runtime recovery.

## Export allowlist

Only the files listed in `PUBLIC_EXPORT_MANIFEST.json` are intended for this public repository.
