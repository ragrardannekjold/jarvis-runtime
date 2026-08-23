from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from jarvis.cenemy_pr_smm import load_operating_bundle
from jarvis.chat_session_recovery import load_chat_session_recovery_policy
from jarvis.orchestration_mvp import DeterministicStaleSafeWorker, MissionStore
from jarvis.truth_guard import LastKnownGoodStore, PromotionAction, TruthState
from jarvis.truth_guarded_orchestration import (
    TruthGuardCanaryWorker,
    run_guarded_mission,
    run_truth_guard_canary_suite,
)


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_PATH = ROOT / "config/cenemy_pr_smm_operating_bundle_v1.json"
RECOVERY_POLICY_PATH = ROOT / "config/chat_session_recovery_policy.json"
OBJECTIVE = (
    "Продовжуй активне PR/SMM глибоке дослідження, перевір competing "
    "hypotheses і поверни перевірений компактний результат."
)


class TruthGuardedOrchestrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bundle = load_operating_bundle(BUNDLE_PATH)
        self.policy = load_chat_session_recovery_policy(RECOVERY_POLICY_PATH)

    def test_guarded_mission_promotes_and_persists_last_known_good(self) -> None:
        with TemporaryDirectory() as tmp:
            store = MissionStore(tmp)
            submitted = store.submit(
                bundle=self.bundle,
                objective=OBJECTIVE,
                source_refs=["AI-49"],
            )
            result = run_guarded_mission(
                store,
                str(submitted["mission_id"]),
                worker=TruthGuardCanaryWorker(fail_first_attempt=False),
                recovery_policy=self.policy,
            )
            self.assertEqual(result["status"], "SUCCEEDED")
            self.assertEqual(
                result["truth_state"],
                TruthState.VERIFIED_COMPLETE.value,
            )
            self.assertTrue(result["promotion_decision"]["allowed"])
            self.assertEqual(
                result["promotion_decision"]["action"],
                PromotionAction.PROMOTE.value,
            )
            self.assertTrue(result["terminal_readback"]["quality_floor_loaded"])
            self.assertTrue(
                result["terminal_readback"]["product_quality_recovered"]
            )
            active, active_ref = LastKnownGoodStore(tmp).active_snapshot(
                str(result["project"])
            )
            self.assertIsNotNone(active)
            self.assertEqual(active.candidate_id, result["mission_id"])
            self.assertEqual(
                active_ref,
                f"mission://{result['mission_id']}/terminal-readback",
            )

    def test_worker_success_claim_without_quality_snapshot_is_blocked(self) -> None:
        with TemporaryDirectory() as tmp:
            store = MissionStore(tmp)
            submitted = store.submit(
                bundle=self.bundle,
                objective=OBJECTIVE,
            )
            result = run_guarded_mission(
                store,
                str(submitted["mission_id"]),
                worker=DeterministicStaleSafeWorker(fail_first_attempt=False),
                recovery_policy=self.policy,
            )
            self.assertEqual(result["status"], "FAILED")
            self.assertEqual(
                result["truth_state"],
                TruthState.VERIFIED_PARTIAL.value,
            )
            self.assertEqual(
                result["checkpoint"]["stage"],
                "QUALITY_SNAPSHOT_REJECTED",
            )
            self.assertEqual(
                result["terminal_readback"]["status"],
                "REJECTED_BY_TRUTH_GUARD",
            )

    def test_lower_quality_candidate_rolls_back_to_last_known_good(self) -> None:
        with TemporaryDirectory() as tmp:
            store = MissionStore(tmp)
            first = store.submit(
                bundle=self.bundle,
                objective=OBJECTIVE,
                source_refs=["AI-49", "first"],
            )
            first_result = run_guarded_mission(
                store,
                str(first["mission_id"]),
                worker=TruthGuardCanaryWorker(
                    fail_first_attempt=False,
                    quality_score=10.0,
                ),
                recovery_policy=self.policy,
            )
            self.assertEqual(first_result["status"], "SUCCEEDED")

            second = store.submit(
                bundle=self.bundle,
                objective=OBJECTIVE + " Контрольний варіант два.",
                source_refs=["AI-49", "second"],
            )
            second_result = run_guarded_mission(
                store,
                str(second["mission_id"]),
                worker=TruthGuardCanaryWorker(
                    fail_first_attempt=False,
                    quality_score=9.0,
                ),
                recovery_policy=self.policy,
            )
            self.assertEqual(second_result["status"], "FAILED")
            self.assertEqual(
                second_result["checkpoint"]["stage"],
                "NON_DEGRADATION_REJECTED",
            )
            self.assertEqual(
                second_result["promotion_decision"]["action"],
                PromotionAction.ROLLBACK.value,
            )
            self.assertIn(
                "QUALITY_SCORE_REGRESSED_FROM_LKG",
                second_result["promotion_decision"]["regressions"],
            )
            active, active_ref = LastKnownGoodStore(tmp).active_snapshot(
                str(first_result["project"])
            )
            self.assertEqual(active.candidate_id, first_result["mission_id"])
            self.assertEqual(
                active_ref,
                f"mission://{first_result['mission_id']}/terminal-readback",
            )

    def test_duplicate_writer_candidate_is_quarantined(self) -> None:
        with TemporaryDirectory() as tmp:
            store = MissionStore(tmp)
            submitted = store.submit(
                bundle=self.bundle,
                objective=OBJECTIVE,
            )
            result = run_guarded_mission(
                store,
                str(submitted["mission_id"]),
                worker=TruthGuardCanaryWorker(
                    fail_first_attempt=False,
                    duplicate_writers=1,
                ),
                recovery_policy=self.policy,
            )
            self.assertEqual(result["status"], "FAILED")
            self.assertEqual(
                result["promotion_decision"]["action"],
                PromotionAction.QUARANTINE.value,
            )
            self.assertEqual(result["truth_state"], TruthState.BLOCKED.value)

    def test_ten_guarded_canaries_pass_without_user_orchestration(self) -> None:
        with TemporaryDirectory() as tmp:
            result = run_truth_guard_canary_suite(
                root=tmp,
                bundle=self.bundle,
                recovery_policy=self.policy,
                objective=OBJECTIVE,
                source_refs=["AI-49"],
                repeat=10,
            )
            self.assertEqual(result.status, "PASS")
            self.assertEqual(result.passed, 10)
            self.assertEqual(result.requested, 10)
            self.assertEqual(result.user_orchestration_touches, 0)
            self.assertTrue(all(run["status"] == "PASS" for run in result.runs))


if __name__ == "__main__":
    unittest.main()
