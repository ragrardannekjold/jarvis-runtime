# Async Public Job Fabric

Purpose: move bounded, non-sensitive work off the ChatGPT foreground turn and provide real external status/readback.

## Dispatch contract
Create an issue in `jarvis-runtime` with a title beginning `[ASYNC-JOB]` and a JSON body such as:

```json
{
  "schema_version": 1,
  "job_type": "heartbeat_probe",
  "sensitivity": "public",
  "workload_class": "normal"
}
```

Only repository-owner-created issues run. Only allowlisted job types run. The public worker rejects private sensitivity, unknown job types, `payload_ref`, and oversized payloads.

## Status
The worker posts issue comments with `ACCEPTED`, `RUNNING`, heartbeat timestamps, and `SUCCEEDED` or `FAILED`. A job is not considered outsourced unless a real GitHub Actions run and issue readback exist.

## Resource policy
The 40/60 numbers are policy targets, not a claim of measured ChatGPT utilization:
- foreground/control-plane target: <= 40%
- reserve target: >= 60%

Heavy or long work should move to external workers/providers where possible. Safety-critical and user dialogue capacity must not be consumed by background work.

## Privacy boundary
This public fabric MUST NOT carry private investigation text, client data, secrets, coordinates, personal data, or other sensitive payloads. Private jobs remain fail-closed until a verified private payload bridge exists. The future bridge should pass opaque job references, not private content through public issues.

## Initial allowlist
- `heartbeat_probe` — proves dispatch/heartbeat/readback without meaningful compute.
- `utility_search_self_test` — runs Utility Search tests on an external GitHub runner.
