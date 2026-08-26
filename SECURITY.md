# Security

This repository is public while its future bridge executes against a private control plane.

## Never publish

Do not commit or upload:
- private command-center contents;
- project names or client tasking that are not intentionally public;
- checkpoints, result ledgers, research archives, payment information, account identifiers, personal data, or geospatial tasking;
- logs from commands executed inside the private checkout;
- tokens, deploy keys, private keys, or repository secrets.

## Workflow rule

Any workflow with access to `COMMAND_CENTER_TOKEN` must run only from trusted code on the default branch or manual/scheduled events controlled by the repository owner. Do not use `pull_request_target`.

The same trigger boundary applies to provider credentials. Shodan readback output must remain finite and redacted: never print the credential, request URL, plan name, exact balances, or provider response body. Credential validation may call only `/api-info`.

Passive searches may run only through `exposure-intelligence.yml` after a strict private task readback. The task must be unexpired, owner-approved, exact-target authorized, passive-only, and capped at one page and one Shodan query credit. The workflow writes a private fail-closed start marker before the provider call; an ambiguous outcome must never trigger an automatic retry or fallback. Active-scan endpoints are outside this runtime's capability contract.

The bridge schedule stays disabled until the secrets exist and a manual bridge test passes.

## Knowledge and Skills Bus

The packet contract and canary are available, but `bus_packet_validate` is not allowed on the public issue queue. GitHub issue bodies are scrapeable and must contain only opaque public control metadata. Never place system details, client data, credentials, investigation targets or results, access telemetry, or threat-intelligence holdings in an issue.

Runtime activation requires an authenticated private transport, opaque packet references, independently revocable least-privilege credentials, bounded retention and verified deletion, and a readback bound to the exact packet identity. Missing telemetry remains `UNKNOWN` and must never become a claim that hostile observation is absent.

## Runtime Anomaly Sentinel

The source-native sentinel may publish only public GitHub workflow name, run URL/ID, bounded timestamps, state class, occurrence count, and deterministic fingerprint. It must not publish actor identity, commit messages, event inputs, mailbox content or addresses, private-repository facts, credentials, attachments, investigation data, user/client data, or arbitrary API responses.

The sentinel records and resolves incidents but never reruns workflows, changes permissions, rotates credentials, or follows links from email. Unallowlisted cancellation and incomplete coverage remain `UNKNOWN`.

## Token scope

Use a fine-grained token limited to the one private command-center repository. Start with `Contents: Read and write` only. Add another permission only when a verified runtime requirement cannot be satisfied without it.

## Incident response

If a secret is ever printed, uploaded, exposed to untrusted code, or suspected compromised:
1. revoke the token immediately;
2. disable the bridge workflow;
3. rotate the token;
4. inspect public workflow logs and artifacts;
5. record the incident in the private command center before resuming.
