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

The same trigger boundary applies to `SHODAN_API_KEY`. Shodan readback output must remain finite and redacted: never print the credential, request URL, plan name, exact balances, or provider response body. Credential validation may call only `/api-info`; searches and scans require separate target authorization and execution gates.

The bridge schedule stays disabled until the secrets exist and a manual bridge test passes.

## Token scope

Use a fine-grained token limited to the one private command-center repository. Start with `Contents: Read and write` only. Add another permission only when a verified runtime requirement cannot be satisfied without it.

## Incident response

If a secret is ever printed, uploaded, exposed to untrusted code, or suspected compromised:
1. revoke the token immediately;
2. disable the bridge workflow;
3. rotate the token;
4. inspect public workflow logs and artifacts;
5. record the incident in the private command center before resuming.
