# AI-49 exact-core verification probe

This marker triggers the public workflow against the sanitized bundle.

The bundle includes the exact `truth_guard.py` and exact core unit-test blobs from private command-center PR #95. Their Git blob identities are checked before tests run.

Only completed workflow steps and the terminal JSON artifact count as verification.
