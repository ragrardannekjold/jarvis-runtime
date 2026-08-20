# JARVIS Public Runtime

This repository is the **sanitized public runtime** for the private command center. It intentionally contains no project data, client data, checkpoints, research, payment records, result ledgers, coordinates, or private history.

## Purpose

Use standard GitHub-hosted runners in a public repository while keeping the authoritative command center private.

The public runner is designed to:
1. check out this public runtime;
2. use narrowly scoped repository secrets: `COMMAND_CENTER_TOKEN` for the private bridge and `SHODAN_API_KEY` only for the Shodan capability;
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
- `SHODAN_API_KEY` is consumed only by the owner-controlled readback workflow. The workflow calls the official `/api-info` endpoint, never prints the key, plan, or exact balances, and performs no search or scan.
- Runtime state belongs in the private `jarvis-runtime-state` branch.

## Current capability

The secret-free public runner self-test is verified working. The authenticated private bridge remains disabled until `COMMAND_CENTER_TOKEN` is configured and a manual bridge test passes.

The Shodan lane has an independent owner-controlled credential readback at `.github/workflows/shodan-runtime-readback.yml`. Live run [#1](https://github.com/ragrardannekjold/jarvis-runtime/actions/runs/32364522450) verified this runtime can authenticate to Shodan without search or scan execution and with zero query credits spent. The public receipt contains capability booleans only; it does not expose the credential, account plan, or exact balances. This readback does not enable active scanning or remove the existing target-authorization gates.

Phase 1 restores **independent control-plane validation** outside the private repository's billing-blocked GitHub-hosted Actions.

It does **not yet** execute project-native workflows locally. The heartbeat therefore explicitly reports:

`local_project_executor_dispatch = NOT_YET_ENABLED`

That state must not be described as full runtime recovery.

## Export allowlist

Only the files listed in `PUBLIC_EXPORT_MANIFEST.json` are intended for this public repository.
