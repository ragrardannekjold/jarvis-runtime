# Runtime Anomaly Sentinel v0.1

This source-native Anomaly Bus sentinel observes GitHub Actions directly instead of treating email notifications as the source of truth.

It classifies the latest default-branch run per active workflow as `ACTIVE_FAILURE`, `RECOVERED_INCIDENT`, `EXPECTED_CANCEL`, `DECOMMISSIONED`, `HEALTHY`, or `UNKNOWN`. Active failures are collapsed into one sanitized `[ANOMALY]` issue per deterministic workflow/incident fingerprint. A newer successful run closes the matching open incident. Retired, quarantined, and default-branch-removed workflows close stale incidents as `DECOMMISSIONED`. Repeated scans with the same run produce no write.

## Security and privacy boundary

- Only public repository workflow metadata is written to public issues.
- Mailbox bodies, addresses, private-repository data, credentials, event inputs, commit messages, and attachments are never read or published by this worker.
- Unknown and unallowlisted cancellation states fail closed to `UNKNOWN`.
- `Kyiv V3 public collector` cancellation is currently allowlisted only as concurrency replacement because its workflow declares `cancel-in-progress: true`.
- The worker never reruns failed workflows or changes credentials. It records and resolves incidents; repair remains a separate authorized lane.

Run locally:

```sh
node --test runtime/anomaly-sentinel/sentinel.test.mjs
node runtime/anomaly-sentinel/canary.mjs
```
