# Investigation Evidence Workers

Small deterministic modules for moving repetitive public-evidence processing off the ChatGPT foreground turn.

## Components

- `harvester.mjs` — HTTPS-only, static-origin-allowlisted document snapshotting, canonical URL cleanup, content hashing, semantic text normalization, and snapshot diffing.
- `entity-resolver.mjs` — deterministic conservative entity clustering by strong identifiers (tax ID, domain) and jurisdiction-scoped normalized names.

## Safety and privacy boundary

This directory is suitable only for **public, non-sensitive evidence processing**.

The GitHub public async fabric must not receive private investigation text, coordinates, client data, credentials, hidden target lists, or arbitrary URLs. Real collection must use a repository-controlled static origin allowlist or a future verified private payload bridge. The public worker does not provide arbitrary shell execution or active scanning.

The harvester rejects non-HTTPS URLs, non-allowlisted origins, localhost/private/link-local IP literals, oversized responses, and credential-bearing URLs. Self-tests use an injected fake `fetch` implementation and make no live network requests.

## Evidence contract

A snapshot records source URL, fetch timestamp, HTTP status, content type, selected cache headers, byte length, raw SHA-256, normalized-text SHA-256, and title. A diff explicitly distinguishes raw change from semantic text change.

The resolver preserves aliases, source references, match keys, and member counts. Name-only matching is jurisdiction-scoped; the resolver does not claim corporate identity from a fuzzy name match alone.

## Async job integration

Only self-tests are initially allowlisted:

- `evidence_harvester_self_test`
- `entity_resolver_self_test`

Both are offline canaries. Live source collection should be enabled only after CI is green and a static public-source allowlist has been reviewed.
