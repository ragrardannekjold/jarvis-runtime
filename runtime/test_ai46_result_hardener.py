from __future__ import annotations

import copy
import unittest

from ai46_result_hardener import (
    HARDENED_SCHEMA,
    harden_result,
    validate_safe_output,
    validate_seal,
)


def raw_fixture() -> dict:
    return {
        "schema_version": "AI46_AGGREGATE_V0_1",
        "mission_id": "AI46-TEST",
        "status": "VERIFIED_DONE",
        "worker_count_expected": 3,
        "worker_count_accepted": 3,
        "worker_count_rejected": 0,
        "worker_statuses": {
            "cybint": "VERIFIED_DONE",
            "terrain": "VERIFIED_DONE",
            "entity": "VERIFIED_DONE",
        },
        "candidate_ledger": {
            "AS202279_RESTRUCTURING": {"confidence": 0.75, "state": "SUPPORTED"},
            "D4": {
                "state": "WEAK",
                "organized_presence_confidence": 0.32,
                "terrain_artifact_weight": 0.30,
                "agriculture_explanation_weight": 0.70,
            },
        },
        "evidence_impacts": [
            {
                "worker_id": "cybint",
                "claim_id": "AI39-CYBINT-AS202279-RESTRUCTURING",
                "candidate_id": "AS202279_RESTRUCTURING",
                "state": "SUPPORTED",
                "statement": "Routing persists while aggregate exposure remains low.",
                "prior_confidence": 0.70,
                "updated_confidence": 0.75,
            },
            {
                "worker_id": "terrain",
                "claim_id": "AI39-D4-TERRAIN-CONFOUND",
                "candidate_id": "D4",
                "state": "SUPPORTED",
                "statement": "D4 is in the AOI low-relief tail.",
                "prior_alternative_weight": 0.45,
                "updated_alternative_weight": 0.30,
            },
            {
                "worker_id": "entity",
                "claim_id": "AI39-ENTITY-UK-SANCTIONS-DIRECT-MATCH",
                "candidate_id": "AS202279_RESTRUCTURING",
                "state": "UNRESOLVED",
                "statement": "No direct textual match.",
            },
        ],
        "aggregate_sha256": "a" * 64,
        "external_side_effects": False,
    }


class AI46ResultHardenerTests(unittest.TestCase):
    def test_numeric_deltas_are_rejected_not_promoted(self) -> None:
        hardened = harden_result(raw_fixture())
        self.assertEqual(hardened["schema_version"], HARDENED_SCHEMA)
        self.assertEqual(hardened["numeric_updates_promoted"], 0)
        self.assertEqual(len(hardened["rejected_numeric_updates"]), 2)
        self.assertNotIn(
            "confidence", hardened["candidate_ledger"]["AS202279_RESTRUCTURING"]
        )
        self.assertNotIn("terrain_artifact_weight", hardened["candidate_ledger"]["D4"])
        self.assertEqual(
            hardened["candidate_ledger"]["D4"]["organized_presence_movement"],
            "UNCHANGED",
        )
        validate_seal(hardened, "hardened_sha256")

    def test_directional_evidence_is_preserved(self) -> None:
        hardened = harden_result(raw_fixture())
        self.assertEqual(hardened["material_evidence_change_count"], 1)
        self.assertEqual(hardened["corroboration_count"], 1)
        self.assertEqual(
            hardened["candidate_ledger"]["D4"]["terrain_artifact_movement"],
            "WEAKENED",
        )
        self.assertEqual(
            hardened["candidate_ledger"]["AS202279_RESTRUCTURING"]["evidence_movement"],
            "RECONFIRMED",
        )

    def test_forbidden_key_fails_closed(self) -> None:
        unsafe = raw_fixture()
        unsafe["evidence_impacts"][0]["ip"] = "192.0.2.1"
        with self.assertRaisesRegex(ValueError, "forbidden key"):
            harden_result(unsafe)

    def test_ip_value_fails_closed_even_under_allowed_key(self) -> None:
        unsafe = raw_fixture()
        unsafe["evidence_impacts"][0]["statement"] = "Observed 192.0.2.1"
        with self.assertRaisesRegex(ValueError, "IP-like value"):
            harden_result(unsafe)

    def test_coordinate_pair_value_fails_closed(self) -> None:
        unsafe = raw_fixture()
        unsafe["evidence_impacts"][0]["statement"] = "At 48.12345, 37.98765"
        with self.assertRaisesRegex(ValueError, "coordinate-like value"):
            harden_result(unsafe)

    def test_tamper_breaks_hardened_seal(self) -> None:
        hardened = harden_result(raw_fixture())
        tampered = copy.deepcopy(hardened)
        tampered["status"] = "FALSE_READY"
        with self.assertRaisesRegex(ValueError, "hardened_sha256 mismatch"):
            validate_seal(tampered, "hardened_sha256")

    def test_external_side_effects_fail_closed(self) -> None:
        unsafe = raw_fixture()
        unsafe["external_side_effects"] = True
        with self.assertRaisesRegex(ValueError, "external side effects"):
            harden_result(unsafe)

    def test_validator_accepts_normal_broad_text(self) -> None:
        validate_safe_output(
            {
                "sector": "D4",
                "statement": "Broad AOI low-relief tail; no exact location output.",
                "count": 15,
            }
        )


if __name__ == "__main__":
    unittest.main()
