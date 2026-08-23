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

## Allowlisted private job types

- `private_integrity_probe`: proves private payload read + private result write without exposing payload.
- `command_center_validation`: runs bounded recovery/stable-state validation against the ephemeral private checkout; raw command output is never printed publicly.
- `ai39_cybint_refresh`: one passive aggregate AI-39 technical refresh for the fixed allowlisted ASN `AS202279`. It uses RIPEstat plus at most one Shodan `/host/count` request with aggregate facets. It performs no active scan and retains no hosts, IPs, banners, vulnerabilities, exact locations or targeting output. Shodan 429/backpressure degrades only the Shodan observation while preserving independent routing evidence.

## Promotion boundary

The generic private bridge was end-to-end exercised before the AI-39 job type was added. Each new job type still requires its own bounded live readback before it is treated as operational evidence collection.

For the bridge itself, the required properties are:

1. private job exists only in the private repository;
2. public issue contains only opaque `job_ref`;
3. GitHub Actions run uses the private bridge token successfully;
4. public status shows `ACCEPTED → RUNNING → SUCCEEDED` or a bounded failure;
5. terminal result exists in the private repository;
6. private payload/result text is absent from public issue comments and workflow logs;
7. duplicate dispatch does not execute the private job twice.
