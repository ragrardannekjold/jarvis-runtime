from __future__ import annotations

import json
import tempfile
import unittest

from jarvis.truth_guard import (
    BaselineIntegrityError,
    LastKnownGoodStore,
    PromotionAction,
    TruthState,
    classify_truth_state,
    default_baseline,
    evaluate_promotion,
    parse_snapshot,
)


def snapshot(candidate_id: str, **overrides):
    data = {
        "candidate_id": candidate_id,
        "quality_score": 10.0,
        "evidence_coverage": 1.0,
        "continuity_recovered": True,
        "product_quality_recovered": True,
        "terminal_readback_verified": True,
        "spend_known": True,
        "new_spend": 0.0,
        "user_orchestration_touches": 0,
        "main_manual_dispatches": 0,
        "duplicate_writers": 0,
        "external_effect_count": 0,
        "rollback_available": True,
        "evidence_refs": [f"test://{candidate_id}"],
    }
    data.update(overrides)
    return parse_snapshot(data)


class TruthGuardTests(unittest.TestCase):
    def test_acknowledgement_without_readback_is_not_complete(self):
        self.assertEqual(
            classify_truth_state(
                attempted=True,
                acknowledged=True,
                result_present=False,
                terminal_readback_verified=False,
                quality_gate_passed=False,
            ),
            TruthState.ACKNOWLEDGED_NOT_VERIFIED,
        )

    def test_candidate_passes_only_with_terminal_and_quality_recovery(self):
        baseline = default_baseline("PR_SMM")
        decision = evaluate_promotion(baseline, snapshot("good"))
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.action, PromotionAction.PROMOTE)
        self.assertEqual(decision.truth_state, TruthState.VERIFIED_COMPLETE)

    def test_polished_ui_cannot_trade_away_evidence_coverage(self):
        baseline = default_baseline("MISSION_CONTROL")
        previous = snapshot("lkg", quality_score=8.0, evidence_coverage=1.0)
        candidate = snapshot("pretty-ui", quality_score=9.0, evidence_coverage=0.8)
        decision = evaluate_promotion(
            baseline,
            candidate,
            previous=previous,
            previous_result_ref="result://lkg",
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.action, PromotionAction.ROLLBACK)
        self.assertIn("EVIDENCE_COVERAGE_REGRESSED_FROM_LKG", decision.regressions)
        self.assertEqual(decision.rollback_target, "result://lkg")

    def test_duplicate_writer_is_quarantined(self):
        baseline = default_baseline("PR_SMM")
        decision = evaluate_promotion(
            baseline,
            snapshot("duplicate", duplicate_writers=1),
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.action, PromotionAction.QUARANTINE)
        self.assertEqual(decision.truth_state, TruthState.BLOCKED)

    def test_terminal_readback_missing_stays_acknowledged_not_verified(self):
        baseline = default_baseline("DEPLOYMENT")
        decision = evaluate_promotion(
            baseline,
            snapshot("write-ack", terminal_readback_verified=False),
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.action, PromotionAction.BLOCK)
        self.assertEqual(
            decision.truth_state,
            TruthState.ACKNOWLEDGED_NOT_VERIFIED,
        )

    def test_last_known_good_is_not_overwritten_by_regression(self):
        baseline = default_baseline("INVESTIGATION")
        first = snapshot("first")
        first_decision = evaluate_promotion(baseline, first)
        with tempfile.TemporaryDirectory() as tmp:
            store = LastKnownGoodStore(tmp)
            store.promote(
                baseline,
                first,
                first_decision,
                result_ref="result://first",
            )
            active, active_ref = store.active_snapshot("INVESTIGATION")
            self.assertEqual(active, first)
            self.assertEqual(active_ref, "result://first")

            degraded = snapshot("degraded", quality_score=9.0)
            rejected = evaluate_promotion(
                baseline,
                degraded,
                previous=active,
                previous_result_ref=active_ref,
            )
            self.assertFalse(rejected.allowed)
            self.assertEqual(rejected.action, PromotionAction.ROLLBACK)
            with self.assertRaises(ValueError):
                store.promote(
                    baseline,
                    degraded,
                    rejected,
                    result_ref="result://degraded",
                )
            current, current_ref = store.active_snapshot("INVESTIGATION")
            self.assertEqual(current, first)
            self.assertEqual(current_ref, "result://first")

    def test_tampered_last_known_good_is_rejected(self):
        baseline = default_baseline("SYSTEM")
        candidate = snapshot("candidate")
        decision = evaluate_promotion(baseline, candidate)
        with tempfile.TemporaryDirectory() as tmp:
            store = LastKnownGoodStore(tmp)
            store.promote(
                baseline,
                candidate,
                decision,
                result_ref="result://candidate",
            )
            path = store.path("SYSTEM")
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw["active_snapshot"]["quality_score"] = 0
            path.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaises(BaselineIntegrityError):
                store.load("SYSTEM")


if __name__ == "__main__":
    unittest.main()
