# GitHub issue event contract

This coordinator is deliberately outside both worker adapters. Cuckoo only
collects one official public snapshot. BUBO only transforms a validated snapshot.
The coordinator owns issue authorization, immutable terminal comments,
idempotency, and the single permitted Cuckoo-to-BUBO transition.

## Trigger

Only an `opened` issue in a public repository created by the repository owner is
accepted. Its title is
exactly `[OUTSOURCE-TASK] <task_id>`, and its body is JSON with these exact keys:

```json
{
  "schema": "public.outsource_issue.v1",
  "envelope": {
    "task_id": "donbas.procurement.001",
    "case_id": "DON-V2-01",
    "worker": "cuckoo",
    "capability": "prozorro_snapshot_v1",
    "sensitivity": "PUBLIC",
    "payload": {
      "record_id": "0123456789abcdef0123456789abcdef"
    }
  },
  "next": {
    "worker": "bubo",
    "capability": "evidence_packet_v1"
  },
  "depends_on": null
}
```

There is no scheduled trigger. The event receiver passes the GitHub issue event
and already-fetched comments into `coordinateIssueTask`. It must authenticate
GitHub itself; this module stores no token and the included workflow uses only
GitHub's short-lived, repository-scoped native token. It needs no PAT or other
private long-lived credential.

## Terminal comment

The coordinator posts one bot-authored `OUTSOURCE_RESULT_V1` comment. Its JSON
contains the complete public candidate result and `result_sha256`, computed over
all terminal fields except the hash itself. A changed byte fails validation.
On redelivery, an existing valid terminal comment makes the operation a no-op.

## Chaining

When `next` requests the only allowed transition, the coordinator returns one
deterministic BUBO issue plan. The BUBO issue contains the parent issue number,
task ID, and terminal hash, but not a copied snapshot. Before running BUBO, the
coordinator reads the parent bot comment, verifies its author and SHA-256, and
only then injects the Cuckoo snapshot into the BUBO adapter. Existing identical
child issues are a no-op; a same-title/different-body child is a hard conflict.
The only non-owner issue accepted is this coordinator-generated, provenance-
pinned BUBO child; arbitrary bot-authored Cuckoo tasks remain rejected.

The integration surface has no user-controlled URL, command, executable, token,
or model prompt. The only network location in the worker is the hard-coded
official OpenProcurement endpoint used by Cuckoo.

`.github/workflows/public-outsource-worker.yml` is the event-only canary. It has
no `schedule`, static commands only, a five-minute ceiling, per-issue concurrency,
and the minimum repository permissions needed to read and write issues. The
process-local ledger is explicitly ephemeral; issue history and immutable result
markers supply redelivery idempotency across fresh runners.
