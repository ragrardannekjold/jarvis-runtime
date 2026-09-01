# Public outsource worker vertical slice

This is a Node 24, standard-library-only reference runtime for two public,
non-tactical capabilities:

- `cuckoo:prozorro_snapshot_v1` reads one official OpenProcurement tender by
  its 32-hex record ID, exposes a deliberately narrow procurement projection,
  and commits to the unreturned raw response with SHA-256.
- `bubo:evidence_packet_v1` transforms that Cuckoo snapshot into a deterministic,
  candidate-only evidence packet. It never promotes a claim into canonical state.

There are no timers and no model calls. Work begins only when an external
`outsource.task.ready.v1` event is delivered. The runtime rejects non-public
tasks, capability mismatches, schema extras, tactical/private field names,
task-ID reuse with changed input, and results from revoked/stale executions.
The in-process ledger is an ephemeral canary guard, not durable infrastructure.
For the GitHub integration, issue history plus hashed terminal comments provides
cross-run redelivery protection.

## Exact task envelope

```json
{
  "task_id": "donbas.procurement.001",
  "case_id": "DON-V2-01",
  "worker": "cuckoo",
  "capability": "prozorro_snapshot_v1",
  "sensitivity": "PUBLIC",
  "payload": {
    "record_id": "0123456789abcdef0123456789abcdef"
  }
}
```

No extra top-level keys are accepted. The public repository-dispatch wrapper
accepts `{ "event_type": "outsource.task.ready.v1", "client_payload": envelope }`.

## Evidence chain

Pass `cuckooResult.result` (the adapter result inside the dispatcher wrapper)
to BUBO:

```json
{
  "task_id": "donbas.evidence.001",
  "case_id": "DON-V2-01",
  "worker": "bubo",
  "capability": "evidence_packet_v1",
  "sensitivity": "PUBLIC",
  "payload": {
    "cuckoo_result": "<cuckooResult.result>"
  }
}
```

The string placeholder above is illustrative; the API expects the actual JSON
object. The BUBO output contains `CLAIM`, `EVIDENCE`, `SOURCE_GENEALOGY`,
`CONTRADICTIONS`, `CONFIDENCE`, `NEXT_FALSIFIER`, and `SENSITIVITY`, plus an
explicit `PENDING_VERIFIER` admission state.

## GitHub issue coordinator

[`integration/GITHUB_ISSUE_CONTRACT.md`](integration/GITHUB_ISSUE_CONTRACT.md)
defines an owner-created, event-only issue contract. Its terminal comment is
content-addressed. A Cuckoo `next` directive can plan exactly one BUBO issue;
the BUBO run validates and reads the prior bot result instead of trusting copied
evidence. This orchestration remains outside both adapters.

## Test

```sh
npm test
```

All network behavior is dependency-injected and mocked in tests. The runtime
itself uses only Node.js standard APIs.
