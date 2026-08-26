# Knowledge and Skills Bus Core v0.1

This module provides a deterministic Knowledge Bus and Skills Bus contract plus a local canary. It is not connected to the public issue queue: inline issue bodies are scrapeable and cannot provide the confidentiality boundary required for system knowledge.

## What v0.1 does

- accepts only versioned, explicitly public knowledge packets or repository-pinned skill references;
- verifies TTL, provenance, content SHA-256, deterministic packet identity, and lineage shape;
- rejects duplicate identities before side effects;
- converts structured route observations into deterministic gap signals;
- never executes skill content, shell strings, arbitrary URLs, or third-party scans;
- leaves private transport and promotion to production disabled.

This is a contract canary, not autonomous self-modification. A later repair lane should use `observe -> diagnose -> repair_spec -> canary -> independent_verify -> promote_or_rollback` with separate authority at promotion.

## Transport state

`bus_packet_validate` is deliberately absent from the public queue allowlist. Do not place a packet in a GitHub issue, even when it is labelled public. The next transport must provide:

- an authenticated private channel;
- opaque queue references rather than inline packet bodies;
- independently revocable least-privilege credentials;
- bounded retention and verified deletion;
- an auditable readback bound to the packet identity.

Until those gates are externally attested, the module and canary remain usable locally and in read-only CI, while the runtime route stays quarantined.

## Security meaning

The bus can prove only what its inputs and evidence chain support. Missing telemetry must be reported as `UNKNOWN`, never as proof that hostile observation is absent. Sensitive system, client, investigation, access, or threat-intelligence data belongs only in a future authenticated private transport and must never be placed in a public issue.

Run locally:

```sh
node --test runtime/knowledge-skill-bus/bus-core.test.mjs
node runtime/knowledge-skill-bus/canary.mjs
```
