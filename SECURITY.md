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

The public bus accepts only inline packets marked `public`. Never place private system details, client data, credentials, investigation targets/results, access telemetry, or threat-intelligence holdings in a queue issue. Skill packets may identify only repository-pinned paths and verifier paths; they are data references and must not introduce arbitrary commands, URLs, downloads, or execution.

A packet may report observed indicators or missing telemetry. It must never convert missing evidence into a claim that hostile monitoring is absent. Treat suspected Russian, allied, contractor, insider, or supply-chain access as a threat hypothesis that requires authorized, asset-scoped telemetry and independent corroboration.

## Token scope

Use a fine-grained token limited to the one private command-center repository. Start with `Contents: Read and write` only. Add another permission only when a verified runtime requirement cannot be satisfied without it.

## Incident response

If a secret is ever printed, uploaded, exposed to untrusted code, or suspected compromised:
1. revoke the token immediately;
2. disable the bridge workflow;
3. rotate the token;
4. inspect public workflow logs and artifacts;
5. record the incident in the private command center before resuming.
