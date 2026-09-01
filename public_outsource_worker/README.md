# Public outsource worker vertical slice

This is a Node 24, standard-library-only reference runtime for two public,
non-tactical capabilities:

- `cuckoo:prozorro_snapshot_v1` reads one official Prozorro tender by
  its 32-hex record ID, exposes a deliberately narrow procurement projection
  with buyer and awarded supplier legal identities, status, counts and values,
  and commits to the unreturned exact HTTP body bytes with SHA-256.
- `bubo:evidence_packet_v1` transforms that Cuckoo snapshot into a deterministic,
  candidate-only evidence packet. It never promotes a claim into canonical state.

There are no timers and no model calls. Work begins only when an owner opens an
exact `[OUTSOURCE-TASK]` issue in the public canary repository. The runtime rejects non-public
tasks, capability mismatches, schema extras, tactical/private field names,
task-ID reuse with changed input, and results from revoked/stale executions.
Personal contacts, addresses, coordinates, document URLs, free-form titles and
descriptions, and tactical fields never enter the normalized result. The exact
source body is not retained by this public canary; a verifier must archive it in
an approved evidence store before promoting the candidate.
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
    "record_id": "267a034fb6674d629db7aaacddff36b8"
  }
}
```

No extra top-level keys are accepted. There is no `repository_dispatch` path.

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
content-addressed. A Cuckoo `next` directive creates exactly one BUBO journal
issue and executes BUBO in the same bounded workflow run; GitHub-token-created
issues are not expected to wake another workflow. Only owner-authored roots and
bot-authored deterministic children count for task identity; same-title issues
by other users are ignored. A rerun of the owner event
resumes an existing child that has no terminal result. BUBO validates and reads
the prior bot result instead of trusting copied evidence. This orchestration
remains outside both adapters.

The active workflow belongs at repository root:
[`../.github/workflows/public-outsource-worker.yml`](../.github/workflows/public-outsource-worker.yml).

## Test

```sh
node --test
```

All network behavior is dependency-injected and mocked in tests. The runtime
itself uses only Node.js standard APIs.

Adapter execution is at-least-once: a runner failure after a read but before its
terminal comment can repeat the read. Committed terminal results are
content-addressed and deduplicated. Cuckoo records a fresh retrieval time for
each official read; BUBO is deterministic for one exact Cuckoo snapshot.
