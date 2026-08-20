# Shodan Investigation risk register

This is an enforcement contract for the passive Investigation sensor, not an
operator checklist. The worker must handle these cases without routine user
intervention and without stopping the parent Investigation.

| Failure class | Consequence | Automatic guard and reaction | User interruption |
|---|---|---|---|
| Count-only over-restriction | The integration consumes attention but produces no investigation value | Count is preflight only; positive exact-domain anchors proceed to bounded passive search and private normalization | Never |
| Accidental active scan | Unauthorised third-party interaction and scan-credit spend | The task schema has no scan operation; the client allowlists only `/count`, `/api-info`, `/search`, and bounded `/host/{ip}?history=true`; tests reject `/scan` | Never; active scanning belongs to a different explicitly authorised capability |
| Broad or injected query | Scope expansion, excess credits, misleading associations | Queries are compiled only from validated authoritative exact-domain anchors; arbitrary Shodan syntax is not accepted | Never |
| Secret leakage | API or bridge credential compromise | Credentials are read only from secrets, never persisted or returned; provider URLs/errors are not logged; CI masks secrets | Only for actual key rotation/revocation |
| Malicious banner or prompt injection | Instructions or hostile HTML influence an agent/user | Raw `data`, HTML, screenshots and arbitrary text are never persisted or sent to an LLM; provider data is labelled untrusted; only typed bounded fields survive | Never |
| CVE false positive | Incorrect vulnerability claim | Preserve `verified` state; every CVE is a lead requiring independent corroboration; unverified CVEs cannot become findings | Never for collection; corroboration is a later workflow |
| Shared hosting/CDN association | Wrong entity attribution | Accept a record only when `hostnames` contains the exact anchor; ignore provider roll-up `domains`; label association lead-only | Never |
| Stale or missing timestamps | Old exposure presented as current | Every observation is `FRESH`, `AGED`, `STALE`, or `UNKNOWN`; stale observations cannot support a current-state claim | Never |
| Credit shortage or surprise spend | Partial run or unexpected cost | Free counts first, then `/api-info`; search starts only if the declared credit budget and live balance cover all positive anchors; cash spend remains zero | Only before any new paid purchase, never for normal depletion |
| Timeout after paid search | Duplicate credits on retry | Search transport/5xx outcome becomes `AMBIGUOUS`; no automatic retry or provider failover; receipt records a credit range | Only if a later manual re-run is desired |
| Rate limit/provider outage | Sensor failure blocks the project | Sensor becomes `PARTIAL`/`UNKNOWN`; parent Investigation effect remains `NONE_SENSOR_*`; schedules do not fail-spam for normal provider states | Never for routine outage |
| Pagination explosion | Credit and storage growth | One page per anchor, fixed page size, fixed fields, bounded response and receipt size | Never |
| Duplicate execution | Double billing | Private `STARTED_FAIL_CLOSED` receipt is written before provider use; an existing receipt blocks replay | Only for an ambiguous receipt review |
| Cross-project leakage | One project sees another project's state | Project ID is validated and copied into a project-bound private receipt; public status contains neither anchors nor observations | Never |
| Public/private boundary breach | Targets or evidence appear in CI/logs | Public output contains only status, counts, credit semantics and receipt hashes; normalized IP/port/fingerprint/CVE data exists only in the private state repository | Never |
| Retention/storage growth | Oversized receipts and stale intelligence | Raw responses are discarded, normalized observations are capped, response/receipt byte limits are enforced | Never |
| Provider coverage drift | Absence is misread as safety | Empty results mean `NO_INDEXED_MATCH`, never `NO_EXPOSURE`; Shodan remains one attributed sensor, not ground truth | Never |
| Russian infrastructure dependency | User/system data reaches an untrusted jurisdiction | Runtime egress is restricted to GitHub private state and Shodan API; it never connects to discovered hosts | Never |
| Unit-only success | False claim that the live system works | Status remains `LIVE_READBACK_PENDING` until a private end-to-end receipt is read back from the deployed worker | One explicit publication authority boundary, if still required |

Value gates: active scans = 0, secret leaks = 0, raw banners persisted = 0,
false exact-hostname associations are counted, and value is measured as
hypothesis-changing/corroborated leads per query credit. Repeated runs that do
not change a hypothesis are paused instead of consuming more credits.
