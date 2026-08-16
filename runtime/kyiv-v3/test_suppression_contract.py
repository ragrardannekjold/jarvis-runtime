#!/usr/bin/env python3
from __future__ import annotations

import copy
import unittest

from suppression_contract import (
    default_suppression_state,
    evaluate_suppression_evidence,
    validate_suppression_state,
)


class SuppressionContractTests(unittest.TestCase):
    def setUp(self):
        self.anchor = "2026-08-17T02:00:00Z"
        self.qualified = {
            "registry_status": "UNTESTED",
            "target_class": "BALLISTIC_TEL",
            "effect_status": "ASSET_DISABLED",
            "independent_source_lineages": ["OFFICIAL_BDA", "INDEPENDENT_PRIMARY_IMAGERY"],
            "stable_primary_functional_assessment": True,
            "source_independence_verified": True,
            "region_bucket": "REGION_A",
            "kyiv_capable_scope": True,
            "material_regional_scope": True,
            "public_observed_time_utc": "2026-08-17T00:30:00Z",
            "effect_readback_time_utc": "2026-08-17T01:30:00Z",
            "observability": "STABLE",
            "substitution": "NONE_SEEN",
            "retaliation_signal": "NONE",
        }

    def evaluate(self, **updates):
        payload = copy.deepcopy(self.qualified)
        payload.update(updates)
        return evaluate_suppression_evidence(payload, anchor_utc=self.anchor)

    def test_default_is_unknown_and_zero_effect(self):
        state = default_suppression_state()
        self.assertEqual(state["evidence_state"], "UNKNOWN")
        self.assertEqual(state["effect"]["applied_delta_points"], 0)
        self.assertEqual(validate_suppression_state(state), [])

    def test_strike_report_alone_is_unknown_and_zero_effect(self):
        state = self.evaluate(effect_status="STRIKE_REPORTED")
        self.assertEqual(state["evidence_state"], "UNKNOWN")
        self.assertEqual(state["effect"]["applied_delta_points"], 0)

    def test_hit_without_functional_bda_is_unknown(self):
        state = self.evaluate(effect_status="HIT_CONFIRMED")
        self.assertEqual(state["gates"]["operational_disruption"]["state"], "UNKNOWN")
        self.assertEqual(state["effect"]["applied_delta_points"], 0)

    def test_wrong_or_unknown_capability_scope_is_zero_effect(self):
        for updates in ({"target_class": "PRODUCTION"}, {"kyiv_capable_scope": False}, {"material_regional_scope": False}):
            with self.subTest(updates=updates):
                state = self.evaluate(**updates)
                self.assertEqual(state["effect"]["applied_delta_points"], 0)

    def test_duplicate_or_derivative_source_lineage_is_not_independent(self):
        state = self.evaluate(independent_source_lineages=["OFFICIAL_BDA", "OFFICIAL_BDA"])
        self.assertEqual(state["gates"]["source"]["state"], "UNKNOWN")

    def test_receipt_run_link_mismatch_is_rejected_by_source_gate(self):
        payload = copy.deepcopy(self.qualified)
        payload["run_id"] = "KYIV-RUNTIME-OLD-A1"
        state = evaluate_suppression_evidence(payload, anchor_utc=self.anchor, expected_run_id="KYIV-RUNTIME-NEW-A1")
        self.assertEqual(state["gates"]["source"]["state"], "UNKNOWN")
        self.assertEqual(state["effect"]["applied_delta_points"], 0)

    def test_future_stale_or_post_anchor_bda_fails_closed(self):
        for updates in (
            {"public_observed_time_utc": "2026-08-17T03:00:00Z"},
            {"public_observed_time_utc": "2026-08-16T18:00:00Z"},
            {"effect_readback_time_utc": "2026-08-17T03:00:00Z"},
        ):
            with self.subTest(updates=updates):
                state = self.evaluate(**updates)
                self.assertEqual(state["gates"]["time_validity"]["state"], "UNKNOWN")
                self.assertEqual(state["effect"]["applied_delta_points"], 0)

    def test_all_evidence_gates_pass_but_untested_remains_shadow_zero(self):
        state = self.evaluate()
        self.assertEqual(state["evidence_state"], "QUALIFIED_UNTESTED")
        self.assertEqual(state["effect"]["mode"], "SHADOW_ONLY")
        self.assertEqual(state["effect"]["applied_delta_points"], 0)
        self.assertEqual(validate_suppression_state(state), [])
        self.assertEqual(state["effect"]["never_affects"], ["CAPACITY", "OFFICIAL_ACTIVE", "5M", "15M", "30M"])
        self.assertFalse(state["effect"]["civilian_action_override_allowed"])

    def test_official_active_warning_overrides_even_a_future_verified_feature(self):
        state = self.evaluate(
            registry_status="VERIFIED",
            frozen_effect_magnitude=-1,
            chronological_holdout_passed=True,
            official_active_warning=True,
        )
        self.assertEqual(state["effect"]["mode"], "OVERRIDDEN_BY_FRESH_THREAT_EVIDENCE")
        self.assertEqual(state["effect"]["applied_delta_points"], 0)

    def test_degraded_observability_substitution_or_retaliation_blocks_effect(self):
        base = {
            "registry_status": "VERIFIED",
            "frozen_effect_magnitude": -1,
            "chronological_holdout_passed": True,
        }
        for updates in (
            {"observability": "DEGRADED"},
            {"substitution": "OBSERVED"},
            {"retaliation_signal": "OPERATIONAL"},
        ):
            with self.subTest(updates=updates):
                state = self.evaluate(**base, **updates)
                self.assertEqual(state["effect"]["applied_delta_points"], 0)

    def test_exact_location_fields_are_rejected(self):
        state = self.evaluate(coordinates=[50.0, 30.0])
        self.assertEqual(state["evidence_state"], "REJECTED")
        self.assertEqual(state["gates"]["scope_relevance"]["state"], "FAIL")

    def test_validator_rejects_untested_nonzero_delta(self):
        state = default_suppression_state()
        state["effect"]["applied_delta_points"] = -1
        self.assertIn("UNTESTED_NONZERO_DELTA", validate_suppression_state(state))


if __name__ == "__main__":
    unittest.main()
