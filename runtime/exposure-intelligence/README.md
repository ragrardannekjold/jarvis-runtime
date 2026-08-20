# Private Exposure Intelligence

Dependency-free Node.js 24 package for **passive, read-only exposure intelligence** on assets that are owned or explicitly authorized. It provides a provider-neutral read workflow with:

1. Shodan REST API as the first route when its paid key and query credits are available.
2. Censys Platform API v3 as the first independent standby.
3. Netlas API v1 as the second standby.

The package does not contain a port scanner, vulnerability scanner, rescan call, browser automation, or any endpoint that initiates traffic toward a target. Censys search uses HTTP `POST`, but it reads Censys' existing dataset; it does not call the separate Live Rescan capability.

## Safety contract

- Dry-run is the default. Network access requires the explicit `--execute` flag.
- Every run, including dry-run, requires a local JSON allowlist.
- An executable asset must exactly match one allowlist entry after canonicalization.
- Only exact domains and CIDRs are accepted. Wildcards, URLs, bare IPs, arbitrary search strings, and ASNs are rejected.
- Provider hits are post-filtered locally before evidence commit. CIDR hits must contain an IP inside the exact network; domain hits must contain the exact domain in the address or DNS names. Certificate names alone never authorize a hit. A domain entry does **not** authorize subdomains or wildcard names. Accepted domain observations are sanitized again: unrelated DNS/reverse-DNS/certificate names are removed, and a certificate subject is retained only when it is exactly the authorized domain (or a single exact `CN`).
- The allowlist must explicitly assert `"authorization": "owned_or_explicitly_authorized"`.
- Provider tokens are read only from environment variables and are never accepted as CLI arguments.
- Redirects are rejected. Success bodies are streamed through a 16 MiB hard limit (also checked against `Content-Length`) before JSON parsing. Oversized, truncated, unreadable, and schema-mismatched HTTP 200 responses are ambiguous and cannot fail over automatically.
- Provider responses are normalized locally; SHA-256 is computed from the exact raw response bytes, but those bytes are not stored.
- An ambiguous network/response outcome is recorded and blocks automatic failover.
- Once a provider has committed a page, a later error or open circuit cannot mix partial primary data with standby data. Resume the primary explicitly after review.
- Evidence is append-only NDJSON with a SHA-256 hash chain and redaction of credential-shaped fields.
- One durable base-directory-wide execution lock is acquired before any provider request and held through evidence, checkpoint, and circuit commit. This enforces the strictest documented provider concurrency tier across different assets and prevents cross-asset state races. Its immutable owner token, process identity, and heartbeat support safe dead-owner recovery without unlinking a replacement lock.

## Requirements

- Node.js 24 or newer.
- A Shodan API key and/or a Censys Platform Personal Access Token and/or a Netlas API key.
- A subscription tier that permits the chosen provider endpoint. The adapters read and record provider credit state where the official API exposes it.

No package installation is required.

## Allowlist

Copy and edit `examples/allowlist.json`. Use only assets you own or are explicitly authorized to assess.

```json
{
  "schemaVersion": 1,
  "authorization": "owned_or_explicitly_authorized",
  "assets": [
    { "type": "domain", "value": "example.com" },
    { "type": "cidr", "value": "192.0.2.0/24" }
  ]
}
```

Domains are IDNA-normalized and lowercased. CIDRs are reduced to their canonical network address. A bare IP must be written as an explicitly authorized `/32` or `/128` CIDR.

## Dry-run

This builds all provider queries, validates scope, and reports `networkRequests: 0`.

```bash
node ./bin/exposure-intel.mjs collect \
  --asset example.com \
  --allowlist ./examples/allowlist.json
```

## Execute passive provider reads

Set credentials in the process environment. The package intentionally does not load `.env` files.

```bash
export CENSYS_PLATFORM_TOKEN='...'
export NETLAS_API_KEY='...'
export SHODAN_API_KEY='...'

node ./bin/exposure-intel.mjs collect \
  --asset example.com \
  --allowlist ./examples/allowlist.json \
  --execute \
  --provider auto \
  --max-pages 1
```

Optional Censys organization routing uses `CENSYS_ORGANIZATION_ID`. Shodan is tried first. Before every paid Shodan search page, the adapter calls the no-credit count endpoint and reads `/api-info`; a zero-result query spends no search credit, while insufficient credits fail over before search. Censys and then Netlas are tried only after a clear failure that occurred before any evidence page was committed.

Select a provider explicitly with `--provider shodan`, `--provider censys`, or `--provider netlas`. Shodan pages are fixed at 100 results, Netlas pagination is fixed at 20 results per page, and Censys accepts `--page-size 1..100`.

## Ambiguous outcomes

A transport failure or unreadable success response is evidence-preserving but ambiguous. The command stops without calling standby. Review `evidence/exposure.ndjson`, then retry the same provider deliberately:

```bash
node ./bin/exposure-intel.mjs collect \
  --asset example.com \
  --allowlist ./examples/allowlist.json \
  --execute \
  --provider censys \
  --acknowledge-ambiguous
```

Choosing Netlas explicitly after review is also a deliberate operator decision, not blind failover.

If a Censys page is already committed but pagination is incomplete, `auto` stops with `PARTIAL_PROVIDER_REVIEW_REQUIRED` even when the Censys circuit is open. Review the committed evidence and resume with `--provider censys`; this prevents silent provider mixing.

## State and evidence

By default, runtime files are stored beneath the current directory. Override this with `--base-dir`.

- `.state/checkpoints/<provider>-<query-hash>.json` — deterministic cursor, page, and evidence-head checkpoint.
- `.state/circuits.json` — provider-specific circuit state.
- `.state/run-locks/global-execute.lock` — private global execution lock; dead-owner directories are preserved as token-specific orphan evidence.
- `evidence/exposure.ndjson` — hash-chained redacted evidence events and normalized observations.

Out-of-scope provider hits are discarded before observation commit. The page event records only an aggregate `droppedOutOfScopeCount`; it does not store the rejected hit.

Censys checkpoints preserve the provider `next_page_token`. Netlas checkpoints preserve offsets `0, 20, 40, ...` up to the documented search ceiling. Each page writes its normalized observations first and a final commit marker last; the marker binds the exact observation-ID set, count, raw hash, cursor, and cumulative count. A torn batch without that valid final marker is retried rather than reconstructed as complete. If evidence was committed but a checkpoint write was interrupted, the next run reconstructs the checkpoint from the latest valid commit marker. A checkpoint is usable only when its `evidenceHeadHash` is a verified member of the current ledger and its last page has a valid bound commit marker; deleting or truncating the supporting ledger cannot produce a cached `COMPLETE` result.

An unterminated final NDJSON fragment caused by an interrupted append is the only automatically recoverable ledger corruption. Under the durable evidence lock, the fragment is preserved in a mode-`0600` quarantine file, the last verified newline boundary is restored atomically, and an `evidence_tail_recovered` event is appended. A malformed newline-terminated entry remains a hard failure.

Verify the evidence chain offline:

```bash
node ./bin/exposure-intel.mjs verify --evidence ./evidence/exposure.ndjson
```

Each normalized observation always includes:

- `provider`, `queryHash`, and the authorized `asset`;
- provider observation time in `observedAt` (or the local fetch time when unavailable);
- address, service port/transport/protocol/software;
- certificate fingerprint/subject/issuer/names/validity;
- DNS and reverse-DNS names;
- exact raw-response-byte SHA-256 and record index, without storing the raw response or token.

## Circuit and rate behavior

| Provider | Clear rate/server response | Ambiguous transport/parse outcome |
| --- | --- | --- |
| Shodan | Count and credit preflight precede each paid search page; clear auth, credit, rate, and server errors may use standby before evidence. | Search transport/schema ambiguity records `provider_ambiguous` and blocks standby. |
| Censys | Honors `Retry-After` when present; otherwise uses a bounded cooldown. Clear pre-evidence errors may use standby. | Records `provider_ambiguous`, saves the cursor, and stops. |
| Netlas | Honors documented HTTP 429 `Retry-After`; 402 credits and server errors are recorded. | Records `provider_ambiguous`, saves the offset, and stops. |

The client is sequential and a durable global lock prevents concurrent provider reads even for different assets, which respects the documented Censys Free/Starter single-concurrent-action limit and stays below Netlas parallelism concerns. It never sleeps and retries invisibly: a circuit exposes the cooldown in local state so the next scheduled run can make a deterministic decision.

## Optional ProjectDiscovery validation

ProjectDiscovery tools are **not included or invoked**. `naabu`, `httpx`, and `nuclei` actively probe targets. They may be useful in a separate validation stage only when the exact assets are owned or explicitly authorized, the testing window and rate limits are approved, and active-scan evidence is stored separately from passive provider evidence. Do not infer permission to actively scan from presence in this package's passive allowlist.

If that stage is ever implemented, give it a separate executable, a separate active-scan authorization assertion, conservative rate caps, and a default-off switch. This package must remain read-only.

## Tests

```bash
node --test
node ./bin/exposure-intel.mjs collect --asset example.com --allowlist ./examples/allowlist.json
```

All provider tests use mocked `fetch`. Regression coverage includes pagination/checkpoint replay, mixed in/out-of-scope hits, exact-domain field sanitization, ambiguous schema/stream failures, raw-byte hashing, response-size caps, partial-primary failover blocking, concurrent/dead-owner locks, evidence-head membership, and torn-tail recovery. The test suite does not make live API calls.

## Official sources

Retrieved and checked on 2026-08-16. Only current provider/tool documentation is used for endpoint and behavior claims:

- [Censys Platform API: getting started, authentication, tiers, response codes, and concurrency](https://docs.censys.com/reference/get-started)
- [Shodan REST API: plan info, no-credit count, search, pagination, and credits](https://developer.shodan.io/api)
- [Censys Platform API v3: run a search query](https://docs.censys.com/reference/v3-globaldata-search-query)
- [Censys Query Language, including exact CIDR syntax](https://docs.censys.com/docs/censys-query-language)
- [Netlas API v1: authentication, rate limits, Responses Search, pagination, and errors](https://docs.netlas.io/api-reference/)
- [Netlas query language, including CIDR filters](https://docs.netlas.io/knowledge-base/query-language/)
- [Netlas Responses field reference](https://docs.netlas.io/knowledge-base/field-reference/responses/)
- [ProjectDiscovery naabu overview](https://docs.projectdiscovery.io/opensource/naabu/overview)
- [ProjectDiscovery httpx overview](https://docs.projectdiscovery.io/opensource/httpx/overview)
- [ProjectDiscovery nuclei overview](https://docs.projectdiscovery.io/opensource/nuclei/overview)

No provider credential or paid entitlement was available to this build, so live behavior is not claimed as verified. Endpoint construction, pagination, failure semantics, state recovery, redaction, and normalization are verified with deterministic mocks.
