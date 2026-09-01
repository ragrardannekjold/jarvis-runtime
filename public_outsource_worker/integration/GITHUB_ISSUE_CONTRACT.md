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
      "record_id": "267a034fb6674d629db7aaacddff36b8"
    }
  },
  "next": {
    "worker": "bubo",
    "capability": "evidence_packet_v1"
  },
  "depends_on": null
}
```

There is no scheduled or repository-dispatch trigger. The event receiver passes
the GitHub issue event to `runBoundedIssueChain`. It must authenticate
GitHub itself; this module stores no token and the included workflow uses only
GitHub's short-lived, repository-scoped native token. It needs no PAT or other
private long-lived credential.

## Terminal comment

The coordinator posts one bot-authored `OUTSOURCE_RESULT_V1` comment. Its
base64url-encoded JSON contains the complete public candidate result and
`result_sha256`, computed over all terminal fields except the hash itself. The
encoding prevents official text from terminating the HTML marker. A changed
byte fails validation.
On redelivery, an existing valid terminal comment makes the operation a no-op.
Among trusted producers, the exact task title globally binds `task_id` to one
issue number. A second owner-authored root or bot-authored child with the same
task title is rejected even when its body is byte-identical. Same-title issues
from untrusted users do not bind or poison task identity.

## Chaining

When `next` requests the only allowed transition, the coordinator creates one
deterministic BUBO journal issue. The issue contains the parent issue number,
task ID, and terminal hash, but not a copied snapshot. Because issues created by
the native `GITHUB_TOKEN` do not emit another `issues.opened` workflow run, BUBO
is executed immediately inside the same non-recursive run. That run is bounded
to at most one Cuckoo and one BUBO adapter execution.

Before BUBO runs, the coordinator reads the parent bot comment and verifies its
author, SHA-256, capability, and `case_id`; a child can never cross cases. If a
run stops after child creation, rerunning the original owner workflow finds the
single deterministic child, confirms it has no terminal comment, and resumes it.
If the terminal already exists, the rerun is a no-op. The initial workflow
remains owner-only; the bot-created child does not independently trigger it.

The integration surface has no user-controlled URL, command, executable, token,
or model prompt. The only network location in the worker is the hard-coded
official Prozorro public API endpoint used by Cuckoo.

Cuckoo hashes the exact received HTTP body bytes before strict UTF-8 decoding.
The public canary deliberately does not retain that body because it may contain
contact or location fields excluded from the narrow projection. The hash is a
commitment, not an archive; canonical admission requires a verifier to preserve
and independently recompute the source in an approved evidence store.

The repository-root `.github/workflows/public-outsource-worker.yml` is the
event-only canary. It has
no `schedule`, static commands only, a five-minute ceiling, owner-and-task concurrency,
SHA-pinned checkout/setup actions, disabled credential persistence/package
manager caching, and the minimum repository permissions needed to read and write issues.
Recovery uses exact task-title lookups constrained to the trusted owner or bot
author, so unrelated public issues do not enter the dispatch index. Root and
child task conversations are locked before recovery comments are read, keeping
untrusted public comments outside the terminal journal. The
process-local ledger is explicitly ephemeral; issue history and immutable result
markers supply redelivery idempotency across fresh runners.
Adapter execution itself remains at-least-once if a process stops between a
read and its terminal comment; no exactly-once claim is made.
