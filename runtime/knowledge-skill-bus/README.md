# Knowledge and Skills Bus Core v0.1

This module adds the first useful, external-queue-safe Knowledge Bus and Skills Bus contract. A queue issue is the durable public envelope; the worker validates an inline packet and posts an exact receipt containing its deterministic identity, content hash, and structured gap signals.

## What v0.1 does

- accepts only versioned, explicitly public knowledge packets or repository-pinned skill references;
- verifies TTL, provenance, content SHA-256, deterministic packet identity, and lineage shape;
- rejects duplicate identities before side effects;
- converts structured route observations into deterministic gap signals;
- never executes skill content, shell strings, arbitrary URLs, or third-party scans;
- leaves private transport and promotion to production disabled.

This is a contract and transport canary, not autonomous self-modification. A later repair lane should use `observe -> diagnose -> repair_spec -> canary -> independent_verify -> promote_or_rollback` with separate authority at promotion.

## External queue job

Create an owner-authored `[QUEUE-JOB]` issue with the existing queue envelope:

```json
{
  "schema_version": 1,
  "job_type": "bus_packet_validate",
  "sensitivity": "public",
  "payload": {
    "mission_id": "BUS-CORE-001",
    "route_id": "KNOWLEDGE-SKILLS",
    "cell_id": "PACKET-001",
    "packet": "<sealed packet object>"
  }
}
```

The whole queue payload remains subject to the queue's 2048-byte limit. `packet_id` and `provenance.content_sha256` must be produced by `sealPacket`; consumers must use `inspectPacket`.

## Security meaning

The public bus can prove only what its inputs and evidence chain support. Missing telemetry must be reported as `UNKNOWN`, never as proof that hostile observation is absent. Sensitive system, client, investigation, access, or threat-intelligence data belongs only in a future authenticated private transport and must never be placed in this public queue.

Run locally:

```sh
node --test runtime/knowledge-skill-bus/bus-core.test.mjs
node runtime/knowledge-skill-bus/canary.mjs
```
