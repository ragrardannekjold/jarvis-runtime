# Private Async Reference Bridge

Purpose: move bounded private work off the ChatGPT foreground turn without placing private task content or private results on the public runtime surface.

## Public surface

A public trigger contains only:

```json
{"schema_version":1,"job_ref":"paj-<24 hex chars>"}
```

No task description, project name, source data, result data, target, credential, or private payload is permitted in the public trigger.

## Private surface

Canonical private jobs live in `ragrardannekjold/jarvis-command-center` under:

- `automation/private_async/jobs/<job_ref>.json`
- `automation/private_async/results/<job_ref>.json`

The public runner receives the private repository through the existing `COMMAND_CENTER_TOKEN`, reads the job ephemerally, executes only an allowlisted implementation, and persists only the result receipt back to the private repository.

## Safety properties

- owner-created issue only;
- fixed opaque `job_ref` format;
- public trigger allows no extra metadata;
- private job type allowlist; no arbitrary shell/code payload;
- private payload size bound;
- result path doubles as an idempotency claim;
- second execution of an existing job is rejected or reuses a terminal result;
- public status exposes only job id/ref, lifecycle state, timestamps and privacy booleans;
- no private stdout/stderr is printed;
- no private artifacts are uploaded;
- executor is not a second orchestrator or queue authority;
- 40% working / 60% reserve remains a policy target, not claimed platform telemetry.

## Initial allowlisted private job types

- `private_integrity_probe`: proves private payload read + private result write without exposing payload.
- `command_center_validation`: runs bounded recovery/stable-state validation against the ephemeral private checkout; raw command output is never printed publicly.

## Promotion boundary

This bridge is not production-proven until all of the following are observed in one end-to-end canary:

1. private job exists only in the private repository;
2. public issue contains only opaque `job_ref`;
3. GitHub Actions run uses the private bridge token successfully;
4. public status shows `ACCEPTED → RUNNING → SUCCEEDED` or a bounded failure;
5. terminal result exists in the private repository;
6. canary/private payload text is absent from public issue comments and workflow logs;
7. duplicate dispatch does not execute the private job twice.
