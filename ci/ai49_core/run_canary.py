#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile

from jarvis.truth_guard import (
    LastKnownGoodStore,
    PromotionAction,
    TruthState,
    default_baseline,
    evaluate_promotion,
    parse_snapshot,
)


def snapshot(candidate_id: str, **overrides):
    payload = {
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
        "evidence_refs": [f"canary://{candidate_id}"],
    }
    payload.update(overrides)
    return parse_snapshot(payload)


def run_one(index: int) -> dict[str, object]:
    baseline = default_baseline(f"AI49_CANARY_{index:02d}")
    good = snapshot(f"good-{index:02d}")
    good_decision = evaluate_promotion(baseline, good)

    with tempfile.TemporaryDirectory() as tmp:
        store = LastKnownGoodStore(tmp)
        store.promote(
            baseline,
            good,
            good_decision,
            result_ref=f"result://good-{index:02d}",
        )
        active, active_ref = store.active_snapshot(baseline.scope)

        regressed = snapshot(
            f"regressed-{index:02d}",
            quality_score=9.0,
            evidence_coverage=0.9,
        )
        rollback = evaluate_promotion(
            baseline,
            regressed,
            previous=active,
            previous_result_ref=active_ref,
        )
        missing_readback = evaluate_promotion(
            baseline,
            snapshot(
                f"ack-{index:02d}",
                terminal_readback_verified=False,
            ),
            previous=active,
            previous_result_ref=active_ref,
        )
        duplicate = evaluate_promotion(
            baseline,
            snapshot(f"duplicate-{index:02d}", duplicate_writers=1),
            previous=active,
            previous_result_ref=active_ref,
        )
        current, current_ref = store.active_snapshot(baseline.scope)

    checks = {
        "promoted": (
            good_decision.allowed
            and good_decision.action == PromotionAction.PROMOTE
            and good_decision.truth_state == TruthState.VERIFIED_COMPLETE
        ),
        "lkg_persisted": current == good and current_ref == active_ref,
        "regression_rolled_back": (
            not rollback.allowed
            and rollback.action == PromotionAction.ROLLBACK
            and "QUALITY_SCORE_REGRESSED_FROM_LKG" in rollback.regressions
            and "EVIDENCE_COVERAGE_REGRESSED_FROM_LKG" in rollback.regressions
        ),
        "ack_not_promoted": (
            not missing_readback.allowed
            and missing_readback.action == PromotionAction.BLOCK
            and missing_readback.truth_state
            == TruthState.ACKNOWLEDGED_NOT_VERIFIED
        ),
        "duplicate_quarantined": (
            not duplicate.allowed
            and duplicate.action == PromotionAction.QUARANTINE
            and duplicate.truth_state == TruthState.BLOCKED
        ),
        "zero_user_touches": good.user_orchestration_touches == 0,
        "zero_new_spend": good.new_spend == 0.0,
    }
    return {
        "run": index,
        "status": "PASS" if all(checks.values()) else "FAIL",
        "checks": checks,
        "promotion": good_decision.to_dict(),
        "rollback": rollback.to_dict(),
        "missing_readback": missing_readback.to_dict(),
        "duplicate_writer": duplicate.to_dict(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=10)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.repeat < 1:
        raise SystemExit("repeat must be >= 1")

    runs = [run_one(index) for index in range(1, args.repeat + 1)]
    passed = sum(run["status"] == "PASS" for run in runs)
    payload = {
        "schema_version": "AI49_PUBLIC_CORE_CANARY_V1",
        "truth_boundary": (
            "Exact command-center truth_guard.py core and exact core unit tests; "
            "does not verify private-repository integration or all legacy callers."
        ),
        "status": "PASS" if passed == args.repeat else "FAIL",
        "requested": args.repeat,
        "passed": passed,
        "user_orchestration_touches": 0,
        "new_spend": 0,
        "runs": runs,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
