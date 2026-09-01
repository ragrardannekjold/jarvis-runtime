# Runtime Anomaly Sentinel v0.3 read-only shadow

This source-native sentinel observes public GitHub Actions metadata and existing sanitized `[ANOMALY]` issues. Version 0.3 is deployed as a read-only shadow, has no mutation authority, and cannot certify `GREEN` until exact live readback and independent WATCH are proven.

Each pinned workflow is evaluated on independent axes:

- `execution_health` inspects trusted same-repository/default-branch run metadata and orders visible attempts by `run_started_at`. GitHub does not expose a complete updated-time cursor for arbitrary historical reruns, so this axis is diagnostic only.
- `scheduled_liveness` uses a separate API query constrained to `event=schedule`. Manual or issue runs cannot refresh a scheduler heartbeat.

The immutable registry in `liveness-contracts.json` covers all 30 workflow sources by exact path, name, API state, and Git blob SHA. Scheduled entries also pin cadence, freshness TTL, grace, activation time, and a recovery quorum of at least two distinct successful pulses.

## Fail-closed states

- No expected pulse after the activation TTL is `ACTIVE_FAILURE / missing_expected_run`.
- A successful pulse whose `created_at` age is at or beyond TTL is `STALE_SUCCESS`, never `HEALTHY` or `RECOVERED_INCIDENT`.
- One fresh pulse after silence is `RECOVERY_PENDING`; it cannot close an incident.
- Only `completed + success + event=schedule` counts toward scheduled recovery. `skipped`, `neutral`, cancelled, running, issue, push, and manual runs do not.
- Disabled non-decommissioned workflows become visible `workflow_disabled` failures after an exact live API-state recheck. Missing contracts, incomplete trees, path/name/blob mismatches, future timestamps, pagination/count drift, source-authority drift, or request-budget exhaustion abort the read-only cycle.

Incident fingerprints are stable by `repository + workflow_path + axis`. The shadow may calculate a diagnostic would-change plan, but it executes no `CREATE`, `UPDATE`, or `CLOSE`; those counts are explicitly non-authoritative because existing issue history is not an authenticated state store. The public readback is forced to at least `AMBER` with `execution_history_complete=false`, `mutation_authority=NONE`, and `actions=[]`.

## Security and privacy boundary

- Public issues contain only public workflow metadata.
- Mailbox bodies, addresses, private-repository data, credentials, event inputs, commit messages, and attachments are never read or published.
- Unknown, running, cancellation, and recovery-pending states never close incidents; this shadow closes no incident in any state.
- Scheduled recovery uses distinct attempt-1 run IDs, the original schedule creation time, a minimum half-cadence separation (at least one minute), and a fully counted bounded recovery window.
- Every run used as evidence is bound to the pinned workflow blob at its exact `head_sha`; fork/PR heads are ignored.
- A hard 100-request cycle budget and zero issue writes keep the ten-minute observer bounded.
- Legacy v1/v2 markers are parsed only for provenance and are not automatically mutated by the v3 planner.
- The production worker uses GET requests only; it never creates, edits, or closes issues, reruns workflows, or changes credentials.

Run locally:

```sh
node --check runtime/anomaly-sentinel/sentinel.mjs
node --check runtime/anomaly-sentinel/worker.mjs
node --test runtime/anomaly-sentinel/*.test.mjs
node runtime/anomaly-sentinel/canary.mjs
```

## Known boundary

This repair prevents stale schedule evidence from becoming certified health when GitHub exposes workflow metadata. The shadow is scheduled every ten minutes, so detection occurs only on the next successful observer cycle after a TTL boundary.

The Sentinel itself still runs on GitHub's scheduler, so it cannot detect a total GitHub scheduler outage with an independent clock. GitHub also does not document a server-side ordering or updated-time cursor that can completely discover an arbitrary rerun from the 30-day rerun window. Those two limits, plus independently enforced branch/ruleset protection, require an independently clocked, signature-validating durable observer/webhook before any write authority, incident closure, or certified `GREEN` may be enabled.
