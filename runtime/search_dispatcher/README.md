# Search Dispatcher v0.2

Search Dispatcher is the contained, local control-plane core for durable search
work. It accepts an idempotent intent, records it in SQLite before scheduling,
executes only an allowlisted Utility Search operation, and requires a separate
terminal readback before completion can be verified.

## Persistence boundary

The checked-in implementation uses a local SQLite database with WAL,
full-synchronous commits, transactional state transitions, leases, and immutable
terminal receipts. That is durable across a local process crash or restart when
the database file is on a persistent filesystem.

The repository does **not** currently activate a remote private production
queue. Private payloads and results must not be written to this public runtime,
and an ephemeral CI runner is not a durable backend. This containment boundary
means that passing local or CI verification is not production activation.

Only a remote durable backend, followed by a canary written in one runtime and
read back after a fresh runtime restart with no lost work or duplicate effect,
can certify `CONTROL_PLANE_PERSISTENT`. The local implementation and this CI
workflow cannot issue that certification.

## Lifecycle and truth

| State | Meaning | Terminal |
| --- | --- | --- |
| `QUEUED` | The immutable intent is durably accepted and awaits capacity. | No |
| `DISPATCH_READY` | An allowlisted route and capacity slot are reserved. No executor success is implied. | No |
| `RUNNING` | The claimed executor attempt has started. Completion is not implied. | No |
| `VERIFIED` | The executor receipt was persisted and independently read back with matching intent, claim, effect key, and proof. | Yes |
| `FAILED` | A proved failure was persisted; retry or failover is allowed only when no effect is established. | Yes |
| `BLOCKED` | Policy, malformed input, or an ambiguous effect prevents safe execution or retry. | Yes |

In particular, `DISPATCH_READY` and `RUNNING` must never be rendered as `DONE`
or otherwise reported as successful. A terminal state is accepted only through
terminal readback of its immutable receipt.

## Capacity and execution

The logical capacity contract is **15/5**: 15 total slots with 5 protected,
leaving at most 10 background slots. Protected capacity is not consumed by
ordinary work. Queue selection skips temporarily saturated lanes so one blocked
job does not stall eligible work behind it.

Execution is deliberately narrow. The real executor launches the repository's
existing Utility Search catalog through a fixed, allowlisted subprocess
contract and records its actual exit status and result proof. A verified,
zero-cost Python snapshot route in a separate failure domain is the default
pre-effect fallback when the Node/catalog route fails clearly; ambiguous
post-effect outcomes are quarantined instead of retried. Queue payloads
cannot provide a command, executable path, shell fragment, or arbitrary URL.
This proves the dispatcher/executor path; it is not a claim that private remote
search collection is active.

## Verification

Run the complete gate from the repository root with Python 3.13 and Node.js 24:

```bash
python runtime/search_dispatcher/verify_all.py \
  --receipt /tmp/search-dispatcher-verification.json
```

The command runs exactly 13 behavioral tests, the real Utility Search smoke
test, and the restart canary. It exits nonzero on any failure and writes the
machine-readable verification receipt only for the observed run. Inspect it
without modifying it:

```bash
python -m json.tool /tmp/search-dispatcher-verification.json
```

The restart canary must show one stable intent and effect, one immutable
terminal receipt, a verified readback through a fresh database connection, and
all unrelated work still `QUEUED`. Its success establishes local restart
durability only; it does not change the remote-production boundary above.
