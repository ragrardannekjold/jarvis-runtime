"""Cross-language golden vector for the Capability R&D receipt contract."""

from __future__ import annotations

import hashlib
import hmac
import json
import unittest


GOLDEN_MAC = "d7653e96e2719f24de3787771cc325813a2a09edb2ce28416d7328c4afa0e436"
TEST_KEY = bytes.fromhex("11" * 32)


def golden_receipt() -> dict[str, object]:
    return {
        "schema_version": 2,
        "private_only": True,
        "capability": "investigation.passive_index_search",
        "task_id": "banderol-perimeter-baseline-20260820-001",
        "project_id": "KYIV",
        "status": "COMPLETE",
        "request_sha256": "a" * 64,
        "started_at": "2026-08-20T13:30:00.000Z",
        "completed_at": "2026-08-20T13:31:00.000Z",
        "runtime_context_binding_sha256": "7" * 64,
        "execution_contract": {
            "active_scanning": False,
            "raw_provider_records_persisted": False,
            "public_target_output": False,
            "runtime_validator": {
                "path": "runtime/investigation_passive_index.mjs",
                "git_blob_sha": "cb2bcdd847389627b8e2774fb1e8c28d9b61b4ab",
            },
        },
        "result": {
            "schema_version": 2,
            "private_only": True,
            "capability": "investigation.passive_index_search",
            "project_id": "KYIV",
            "task_id": "banderol-perimeter-baseline-20260820-001",
            "status": "COMPLETE",
            "error_code": None,
            "provider": "shodan",
            "additional_monetary_spend_usd": 0,
            "provider_requests_sent": 1,
            "query_credits_spent": 0,
            "query_credit_min": 0,
            "query_credit_max": 0,
            "collected_at": "2026-08-20T13:31:00.000Z",
            "observations": [],
            "quality_metrics": {
                "normalized_observations": 0,
                "dropped_out_of_exact_scope": 0,
                "active_scans": 0,
                "raw_banners_persisted": 0,
            },
            "parent_investigation_effect": "NONE_UNTIL_INDEPENDENT_CORROBORATION",
        },
        "attestation": {
            "schema_version": 1,
            "algorithm": "HMAC-SHA256",
            "issuer": "capability.private-runtime",
            "key_id": "CAPRND_RUNTIME_RECEIPT_V1",
            "purpose": "CAPABILITY_RND_RUNTIME_RECEIPT",
            "issued_at": "2026-08-20T13:31:00.000Z",
            "expires_at": "2026-08-20T14:31:00.000Z",
            "nonce": "caprnd-c33de1a4f9443d860bcd31adc69952461f01e1f59308efa4",
            "mac": GOLDEN_MAC,
        },
    }


class CapabilityRndReceiptCompatibilityTests(unittest.TestCase):
    def test_python_command_center_canonicalization_matches_node_emitter(self) -> None:
        receipt = golden_receipt()
        attestation = dict(receipt["attestation"])
        observed = attestation.pop("mac")
        payload = {key: value for key, value in receipt.items() if key != "attestation"}
        encoded = json.dumps(
            {"payload": payload, "attestation": attestation},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        expected = hmac.new(TEST_KEY, encoded, digestmod=hashlib.sha256).hexdigest()
        self.assertEqual(expected, GOLDEN_MAC)
        self.assertTrue(hmac.compare_digest(observed, expected))


if __name__ == "__main__":
    unittest.main()
