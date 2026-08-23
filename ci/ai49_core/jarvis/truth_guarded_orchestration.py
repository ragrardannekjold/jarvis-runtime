from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping

from jarvis.cenemy_pr_smm import CenemyOperatingBundle
from jarvis.chat_session_recovery import ChatSessionRecoveryPolicy
from jarvis.orchestration_mvp import (
    CanarySuiteResult,
    DeterministicStaleSafeWorker,
    MissionStore,
    VERIFIED_DONE,
    Worker,
    run_mission,
)
from jarvis.truth_guard import (
    LastKnownGoodStore,
    PromotionAction,
    QualityBaseline,
    TruthState,
    default_baseline,
    evaluate_promotion,
    snapshot_from_worker,
)


GUARDED_SCHEMA_VERSION = "TRUTH_GUARDED_ORCHESTRATION_V1"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256(value: object) -> str:
    text = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _append_event(state: dict[str, object], event_type: str, **details: object) -> None:
    events = state.setdefault("events", [])
    if not isinstance(events, list):
        raise ValueError("events must be a list")
    item: dict[str, object] = {
        "sequence": len(events) + 1,
        "at": _now(),
        "event_type": event_type,
    }
    if details:
        item["details"] = details
    events.append(item)


def _set_checkpoint(state: dict[str, object], stage: str, **details: object) -> None:
    prior = state.get("checkpoint")
    revision = int(prior.get("revision", 0)) + 1 if isinstance(prior, dict) else 1
    checkpoint: dict[str, object] = {
        "revision": revision,
        "stage": stage,
        "at": _now(),
    }
    if details:
        checkpoint["details"] = details
    state["checkpoint"] = checkpoint


def _set_task_status(state: dict[str, object], status: str) -> None:
    tasks = state.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != 1 or not isinstance(tasks[0], dict):
        raise ValueError("guarded orchestration requires one bounded task")
    tasks[0]["status"] = status


def _invalid_quality_decision(
    *,
    baseline: QualityBaseline,
    candidate_id: str,
    error: Exception,
    rollback_target: str | None,
) -> dict[str, object]:
    material = {
        "allowed": False,
        "action": PromotionAction.BLOCK.value,
        "truth_state": TruthState.VERIFIED_PARTIAL.value,
        "baseline_id": baseline.baseline_id,
        "candidate_id": candidate_id,
        "reasons": ["QUALITY_SNAPSHOT_INVALID"],
        "regressions": [],
        "rollback_target": rollback_target,
        "error_type": type(error).__name__,
        "error": str(error),
    }
    material["decision_sha256"] = _sha256(material)
    return material


def run_guarded_mission(
    store: MissionStore,
    mission_id: str,
    *,
    worker: Worker,
    recovery_policy: ChatSessionRecoveryPolicy,
    baseline: QualityBaseline | None = None,
    max_attempts: int = 3,
) -> dict[str, object]:
    """Run a zero-side-effect mission and promote only through a non-degradation gate."""

    state = run_mission(
        store,
        mission_id,
        worker=worker,
        recovery_policy=recovery_policy,
        max_attempts=max_attempts,
    )

    prior_decision = state.get("promotion_decision")
    if (
        state.get("truth_state") == TruthState.VERIFIED_COMPLETE.value
        and isinstance(prior_decision, dict)
        and prior_decision.get("allowed") is True
    ):
        return state

    if state.get("status") != "SUCCEEDED":
        state["truth_state"] = TruthState.FAILED.value
        state["guard_schema_version"] = GUARDED_SCHEMA_VERSION
        _append_event(
            state,
            "TRUTH_GUARD_INHERITED_WORKER_FAILURE",
            user_retry_required=False,
        )
        return store.save(state)

    project = state.get("project")
    if not isinstance(project, str) or not project.strip():
        raise ValueError("mission project must be non-empty")
    effective_baseline = baseline or default_baseline(project)
    if effective_baseline.scope != project:
        raise ValueError("quality baseline scope must match mission project")

    result = state.get("result")
    telemetry = state.get("telemetry")
    terminal = state.get("terminal_readback")
    if not isinstance(result, Mapping):
        raise ValueError("succeeded mission is missing result")
    if not isinstance(telemetry, Mapping):
        raise ValueError("succeeded mission is missing telemetry")
    terminal_verified = bool(
        isinstance(terminal, Mapping)
        and terminal.get("status") == VERIFIED_DONE
        and terminal.get("mission_id") == mission_id
    )

    lkg_store = LastKnownGoodStore(store.root)
    previous, previous_ref = lkg_store.active_snapshot(project)
    state["guard_schema_version"] = GUARDED_SCHEMA_VERSION
    state["quality_baseline"] = effective_baseline.to_dict()

    try:
        snapshot = snapshot_from_worker(
            result,
            telemetry,
            candidate_id=mission_id,
            terminal_readback_verified=terminal_verified,
        )
    except Exception as exc:
        decision = _invalid_quality_decision(
            baseline=effective_baseline,
            candidate_id=mission_id,
            error=exc,
            rollback_target=previous_ref,
        )
        state["truth_state"] = TruthState.VERIFIED_PARTIAL.value
        state["promotion_decision"] = decision
        state["status"] = "FAILED"
        _set_task_status(state, "FAILED")
        if isinstance(terminal, dict):
            terminal.update(
                {
                    "status": "REJECTED_BY_TRUTH_GUARD",
                    "truth_state": TruthState.VERIFIED_PARTIAL.value,
                    "product_quality_recovered": False,
                    "last_known_good_preserved": previous is not None,
                    "promotion_action": PromotionAction.BLOCK.value,
                    "guard_error": str(exc),
                }
            )
        _set_checkpoint(
            state,
            "QUALITY_SNAPSHOT_REJECTED",
            error_type=type(exc).__name__,
            error=str(exc),
            last_known_good_preserved=previous is not None,
        )
        _append_event(
            state,
            "QUALITY_SNAPSHOT_REJECTED",
            error_type=type(exc).__name__,
            error=str(exc),
            user_retry_required=False,
        )
        return store.save(state)

    decision = evaluate_promotion(
        effective_baseline,
        snapshot,
        previous=previous,
        previous_result_ref=previous_ref,
    )
    state["quality_snapshot"] = snapshot.to_dict()
    state["promotion_decision"] = decision.to_dict()
    state["truth_state"] = decision.truth_state.value

    if not decision.allowed:
        state["status"] = "FAILED"
        _set_task_status(state, "FAILED")
        if isinstance(terminal, dict):
            terminal.update(
                {
                    "status": "REJECTED_BY_NON_DEGRADATION",
                    "truth_state": decision.truth_state.value,
                    "product_quality_recovered": False,
                    "last_known_good_preserved": previous is not None,
                    "promotion_action": decision.action.value,
                    "rollback_target": decision.rollback_target,
                    "reasons": list(decision.reasons),
                }
            )
        _set_checkpoint(
            state,
            "NON_DEGRADATION_REJECTED",
            action=decision.action.value,
            reasons=list(decision.reasons),
            rollback_target=decision.rollback_target,
        )
        _append_event(
            state,
            "NON_DEGRADATION_REJECTED",
            action=decision.action.value,
            reasons=list(decision.reasons),
            last_known_good_preserved=previous is not None,
            user_retry_required=False,
        )
        return store.save(state)

    result_ref = f"mission://{mission_id}/terminal-readback"
    lkg_record = lkg_store.promote(
        effective_baseline,
        snapshot,
        decision,
        result_ref=result_ref,
    )
    state["last_known_good"] = {
        "scope": project,
        "result_ref": result_ref,
        "state_sha256": lkg_record["state_sha256"],
    }
    if isinstance(terminal, dict):
        terminal.update(
            {
                "truth_state": TruthState.VERIFIED_COMPLETE.value,
                "quality_floor_loaded": True,
                "product_quality_recovered": True,
                "promotion_action": PromotionAction.PROMOTE.value,
                "last_known_good_result_ref": result_ref,
                "decision_sha256": decision.decision_sha256,
            }
        )
    _set_checkpoint(
        state,
        "NON_DEGRADATION_PROMOTED",
        baseline_id=effective_baseline.baseline_id,
        result_ref=result_ref,
        decision_sha256=decision.decision_sha256,
    )
    _append_event(
        state,
        "NON_DEGRADATION_PROMOTED",
        baseline_id=effective_baseline.baseline_id,
        result_ref=result_ref,
        user_retry_required=False,
    )
    return store.save(state)


@dataclass(slots=True)
class TruthGuardCanaryWorker:
    """Synthetic zero-spend worker with an explicit quality/evidence contract."""

    fail_first_attempt: bool = True
    quality_score: float = 10.0
    evidence_coverage: float = 1.0
    continuity_recovered: bool = True
    product_quality_recovered: bool = True
    spend_known: bool = True
    new_spend: float = 0.0
    duplicate_writers: int = 0
    rollback_available: bool = True

    def __call__(self, mission: Mapping[str, object]) -> Mapping[str, object]:
        raw = DeterministicStaleSafeWorker(
            fail_first_attempt=self.fail_first_attempt
        )(mission)
        result = copy.deepcopy(dict(raw))
        result["quality_snapshot"] = {
            "quality_score": self.quality_score,
            "evidence_coverage": self.evidence_coverage,
            "continuity_recovered": self.continuity_recovered,
            "product_quality_recovered": self.product_quality_recovered,
            "spend_known": self.spend_known,
            "new_spend": self.new_spend,
            "duplicate_writers": self.duplicate_writers,
            "rollback_available": self.rollback_available,
        }
        return result


def run_truth_guard_canary_suite(
    *,
    root: str | Path,
    bundle: CenemyOperatingBundle,
    recovery_policy: ChatSessionRecoveryPolicy,
    objective: str,
    source_refs: Iterable[str] = (),
    repeat: int = 10,
) -> CanarySuiteResult:
    if repeat < 1:
        raise ValueError("repeat must be >= 1")
    runs: list[dict[str, object]] = []
    passed = 0
    user_touches = 0
    for index in range(1, repeat + 1):
        store = MissionStore(Path(root) / f"run-{index:02d}")
        first = store.submit(
            bundle=bundle,
            objective=objective,
            source_refs=source_refs,
        )
        duplicate = store.submit(
            bundle=bundle,
            objective=objective,
            source_refs=source_refs,
        )
        if first["mission_id"] != duplicate["mission_id"]:
            raise AssertionError("duplicate intake changed mission identity")
        result = run_guarded_mission(
            store,
            str(first["mission_id"]),
            worker=TruthGuardCanaryWorker(),
            recovery_policy=recovery_policy,
        )
        telemetry = result.get("telemetry")
        readback = result.get("terminal_readback")
        decision = result.get("promotion_decision")
        ok = bool(
            result.get("status") == "SUCCEEDED"
            and result.get("truth_state") == TruthState.VERIFIED_COMPLETE.value
            and isinstance(telemetry, dict)
            and telemetry.get("duplicate_submissions") == 1
            and telemetry.get("transport_recoveries") == 1
            and telemetry.get("user_orchestration_touches") == 0
            and telemetry.get("main_manual_dispatches") == 0
            and telemetry.get("external_effect_count") == 0
            and isinstance(readback, dict)
            and readback.get("status") == VERIFIED_DONE
            and readback.get("product_quality_recovered") is True
            and readback.get("quality_floor_loaded") is True
            and isinstance(decision, dict)
            and decision.get("allowed") is True
            and decision.get("action") == PromotionAction.PROMOTE.value
        )
        passed += int(ok)
        if isinstance(telemetry, dict):
            user_touches += int(telemetry.get("user_orchestration_touches", 0))
        runs.append(
            {
                "run": index,
                "status": "PASS" if ok else "FAIL",
                "mission_id": result["mission_id"],
                "attempts": result["attempt"],
                "revision": result["revision"],
                "truth_state": result.get("truth_state"),
                "promotion_decision": decision,
                "terminal_readback": readback,
            }
        )
    return CanarySuiteResult(
        status="PASS" if passed == repeat and user_touches == 0 else "FAIL",
        passed=passed,
        requested=repeat,
        user_orchestration_touches=user_touches,
        runs=tuple(runs),
    )
