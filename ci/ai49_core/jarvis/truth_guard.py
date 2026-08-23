from __future__ import annotations

import copy
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Mapping


SCHEMA_VERSION = "TRUTH_GUARD_V1"


class TruthState(StrEnum):
    PROPOSED = "PROPOSED"
    ATTEMPTED = "ATTEMPTED"
    ACKNOWLEDGED_NOT_VERIFIED = "ACKNOWLEDGED_NOT_VERIFIED"
    VERIFIED_PARTIAL = "VERIFIED_PARTIAL"
    VERIFIED_COMPLETE = "VERIFIED_COMPLETE"
    FAILED = "FAILED"
    BLOCKED = "BLOCKED"
    UNKNOWN = "UNKNOWN"


class PromotionAction(StrEnum):
    PROMOTE = "PROMOTE"
    KEEP_LAST_KNOWN_GOOD = "KEEP_LAST_KNOWN_GOOD"
    ROLLBACK = "ROLLBACK"
    QUARANTINE = "QUARANTINE"
    BLOCK = "BLOCK"


class BaselineIntegrityError(ValueError):
    """The last-known-good record failed its integrity check."""


@dataclass(frozen=True, slots=True)
class QualityBaseline:
    baseline_id: str
    scope: str
    min_quality_score: float
    min_evidence_coverage: float
    require_continuity_recovered: bool
    require_product_quality_recovered: bool
    require_terminal_readback: bool
    require_spend_known: bool
    max_new_spend: float
    max_user_orchestration_touches: int
    max_main_manual_dispatches: int
    max_duplicate_writers: int
    max_external_effect_count: int
    require_rollback_available: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "baseline_id": self.baseline_id,
            "scope": self.scope,
            "min_quality_score": self.min_quality_score,
            "min_evidence_coverage": self.min_evidence_coverage,
            "require_continuity_recovered": self.require_continuity_recovered,
            "require_product_quality_recovered": self.require_product_quality_recovered,
            "require_terminal_readback": self.require_terminal_readback,
            "require_spend_known": self.require_spend_known,
            "max_new_spend": self.max_new_spend,
            "max_user_orchestration_touches": self.max_user_orchestration_touches,
            "max_main_manual_dispatches": self.max_main_manual_dispatches,
            "max_duplicate_writers": self.max_duplicate_writers,
            "max_external_effect_count": self.max_external_effect_count,
            "require_rollback_available": self.require_rollback_available,
        }


@dataclass(frozen=True, slots=True)
class QualitySnapshot:
    candidate_id: str
    quality_score: float
    evidence_coverage: float
    continuity_recovered: bool
    product_quality_recovered: bool
    terminal_readback_verified: bool
    spend_known: bool
    new_spend: float
    user_orchestration_touches: int
    main_manual_dispatches: int
    duplicate_writers: int
    external_effect_count: int
    rollback_available: bool
    evidence_refs: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "candidate_id": self.candidate_id,
            "quality_score": self.quality_score,
            "evidence_coverage": self.evidence_coverage,
            "continuity_recovered": self.continuity_recovered,
            "product_quality_recovered": self.product_quality_recovered,
            "terminal_readback_verified": self.terminal_readback_verified,
            "spend_known": self.spend_known,
            "new_spend": self.new_spend,
            "user_orchestration_touches": self.user_orchestration_touches,
            "main_manual_dispatches": self.main_manual_dispatches,
            "duplicate_writers": self.duplicate_writers,
            "external_effect_count": self.external_effect_count,
            "rollback_available": self.rollback_available,
            "evidence_refs": list(self.evidence_refs),
        }


@dataclass(frozen=True, slots=True)
class PromotionDecision:
    allowed: bool
    action: PromotionAction
    truth_state: TruthState
    baseline_id: str
    candidate_id: str
    reasons: tuple[str, ...]
    regressions: tuple[str, ...]
    rollback_target: str | None
    decision_sha256: str

    def to_dict(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "action": self.action.value,
            "truth_state": self.truth_state.value,
            "baseline_id": self.baseline_id,
            "candidate_id": self.candidate_id,
            "reasons": list(self.reasons),
            "regressions": list(self.regressions),
            "rollback_target": self.rollback_target,
            "decision_sha256": self.decision_sha256,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256(value: object) -> str:
    text = value if isinstance(value, str) else _canonical_json(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _required_text(data: Mapping[str, object], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value.strip()


def _number(data: Mapping[str, object], key: str) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{key} must be numeric")
    return float(value)


def _non_negative_int(data: Mapping[str, object], key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def _required_bool(data: Mapping[str, object], key: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be boolean")
    return value


def default_baseline(scope: str) -> QualityBaseline:
    normalized = scope.strip()
    if not normalized:
        raise ValueError("baseline scope must be non-empty")
    return QualityBaseline(
        baseline_id=f"LKG-{_sha256(normalized)[:16].upper()}",
        scope=normalized,
        min_quality_score=5.0,
        min_evidence_coverage=0.5,
        require_continuity_recovered=True,
        require_product_quality_recovered=True,
        require_terminal_readback=True,
        require_spend_known=True,
        max_new_spend=0.0,
        max_user_orchestration_touches=0,
        max_main_manual_dispatches=0,
        max_duplicate_writers=0,
        max_external_effect_count=0,
        require_rollback_available=True,
    )


def parse_baseline(data: Mapping[str, object]) -> QualityBaseline:
    baseline = QualityBaseline(
        baseline_id=_required_text(data, "baseline_id"),
        scope=_required_text(data, "scope"),
        min_quality_score=_number(data, "min_quality_score"),
        min_evidence_coverage=_number(data, "min_evidence_coverage"),
        require_continuity_recovered=_required_bool(data, "require_continuity_recovered"),
        require_product_quality_recovered=_required_bool(
            data, "require_product_quality_recovered"
        ),
        require_terminal_readback=_required_bool(data, "require_terminal_readback"),
        require_spend_known=_required_bool(data, "require_spend_known"),
        max_new_spend=_number(data, "max_new_spend"),
        max_user_orchestration_touches=_non_negative_int(
            data, "max_user_orchestration_touches"
        ),
        max_main_manual_dispatches=_non_negative_int(
            data, "max_main_manual_dispatches"
        ),
        max_duplicate_writers=_non_negative_int(data, "max_duplicate_writers"),
        max_external_effect_count=_non_negative_int(
            data, "max_external_effect_count"
        ),
        require_rollback_available=_required_bool(data, "require_rollback_available"),
    )
    if not 0 <= baseline.min_quality_score <= 10:
        raise ValueError("min_quality_score must be within 0..10")
    if not 0 <= baseline.min_evidence_coverage <= 1:
        raise ValueError("min_evidence_coverage must be within 0..1")
    if baseline.max_new_spend < 0:
        raise ValueError("max_new_spend must be non-negative")
    return baseline


def parse_snapshot(data: Mapping[str, object]) -> QualitySnapshot:
    evidence_value = data.get("evidence_refs")
    if not isinstance(evidence_value, list) or not evidence_value:
        raise ValueError("evidence_refs must be a non-empty list")
    evidence_refs: list[str] = []
    for value in evidence_value:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("evidence_refs entries must be non-empty strings")
        evidence_refs.append(value.strip())
    snapshot = QualitySnapshot(
        candidate_id=_required_text(data, "candidate_id"),
        quality_score=_number(data, "quality_score"),
        evidence_coverage=_number(data, "evidence_coverage"),
        continuity_recovered=_required_bool(data, "continuity_recovered"),
        product_quality_recovered=_required_bool(data, "product_quality_recovered"),
        terminal_readback_verified=_required_bool(data, "terminal_readback_verified"),
        spend_known=_required_bool(data, "spend_known"),
        new_spend=_number(data, "new_spend"),
        user_orchestration_touches=_non_negative_int(data, "user_orchestration_touches"),
        main_manual_dispatches=_non_negative_int(data, "main_manual_dispatches"),
        duplicate_writers=_non_negative_int(data, "duplicate_writers"),
        external_effect_count=_non_negative_int(data, "external_effect_count"),
        rollback_available=_required_bool(data, "rollback_available"),
        evidence_refs=tuple(sorted(set(evidence_refs))),
    )
    if not 0 <= snapshot.quality_score <= 10:
        raise ValueError("quality_score must be within 0..10")
    if not 0 <= snapshot.evidence_coverage <= 1:
        raise ValueError("evidence_coverage must be within 0..1")
    if snapshot.new_spend < 0:
        raise ValueError("new_spend must be non-negative")
    return snapshot


def snapshot_from_worker(
    result: Mapping[str, object],
    telemetry: Mapping[str, object],
    *,
    candidate_id: str,
    terminal_readback_verified: bool,
) -> QualitySnapshot:
    raw_quality = result.get("quality_snapshot")
    if not isinstance(raw_quality, Mapping):
        raise ValueError("worker result requires quality_snapshot")
    evidence_refs = result.get("evidence_refs")
    if not isinstance(evidence_refs, list):
        raise ValueError("worker result requires evidence_refs")
    data: dict[str, object] = {
        "candidate_id": candidate_id,
        "quality_score": raw_quality.get("quality_score"),
        "evidence_coverage": raw_quality.get("evidence_coverage"),
        "continuity_recovered": raw_quality.get("continuity_recovered"),
        "product_quality_recovered": raw_quality.get("product_quality_recovered"),
        "terminal_readback_verified": terminal_readback_verified,
        "spend_known": raw_quality.get("spend_known"),
        "new_spend": raw_quality.get("new_spend"),
        "user_orchestration_touches": telemetry.get("user_orchestration_touches"),
        "main_manual_dispatches": telemetry.get("main_manual_dispatches"),
        "duplicate_writers": raw_quality.get("duplicate_writers"),
        "external_effect_count": telemetry.get("external_effect_count"),
        "rollback_available": raw_quality.get("rollback_available"),
        "evidence_refs": evidence_refs,
    }
    return parse_snapshot(data)


def classify_truth_state(
    *,
    attempted: bool,
    acknowledged: bool,
    result_present: bool,
    terminal_readback_verified: bool,
    quality_gate_passed: bool,
    failed: bool = False,
    blocked: bool = False,
) -> TruthState:
    if blocked:
        return TruthState.BLOCKED
    if failed:
        return TruthState.FAILED
    if quality_gate_passed and terminal_readback_verified:
        return TruthState.VERIFIED_COMPLETE
    if result_present:
        return TruthState.VERIFIED_PARTIAL
    if acknowledged:
        return TruthState.ACKNOWLEDGED_NOT_VERIFIED
    if attempted:
        return TruthState.ATTEMPTED
    return TruthState.PROPOSED


def evaluate_promotion(
    baseline: QualityBaseline,
    candidate: QualitySnapshot,
    *,
    previous: QualitySnapshot | None = None,
    previous_result_ref: str | None = None,
) -> PromotionDecision:
    reasons: list[str] = []
    regressions: list[str] = []

    if candidate.quality_score < baseline.min_quality_score:
        reasons.append("QUALITY_SCORE_BELOW_FLOOR")
    if candidate.evidence_coverage < baseline.min_evidence_coverage:
        reasons.append("EVIDENCE_COVERAGE_BELOW_FLOOR")
    if baseline.require_continuity_recovered and not candidate.continuity_recovered:
        reasons.append("EXECUTION_CONTINUITY_NOT_RECOVERED")
    if baseline.require_product_quality_recovered and not candidate.product_quality_recovered:
        reasons.append("PRODUCT_QUALITY_NOT_RECOVERED")
    if baseline.require_terminal_readback and not candidate.terminal_readback_verified:
        reasons.append("TERMINAL_READBACK_NOT_VERIFIED")
    if baseline.require_spend_known and not candidate.spend_known:
        reasons.append("SPEND_UNKNOWN")
    if candidate.spend_known and candidate.new_spend > baseline.max_new_spend:
        reasons.append("NEW_SPEND_ABOVE_CEILING")
    if candidate.user_orchestration_touches > baseline.max_user_orchestration_touches:
        reasons.append("USER_ORCHESTRATION_BURDEN_REGRESSION")
    if candidate.main_manual_dispatches > baseline.max_main_manual_dispatches:
        reasons.append("MAIN_MANUAL_DISPATCH_REGRESSION")
    if candidate.duplicate_writers > baseline.max_duplicate_writers:
        reasons.append("DUPLICATE_WRITER_DETECTED")
    if candidate.external_effect_count > baseline.max_external_effect_count:
        reasons.append("UNAPPROVED_EXTERNAL_EFFECT")
    if baseline.require_rollback_available and not candidate.rollback_available:
        reasons.append("ROLLBACK_UNAVAILABLE")

    if previous is not None:
        if candidate.quality_score < previous.quality_score:
            regressions.append("QUALITY_SCORE_REGRESSED_FROM_LKG")
        if candidate.evidence_coverage < previous.evidence_coverage:
            regressions.append("EVIDENCE_COVERAGE_REGRESSED_FROM_LKG")
        if previous.continuity_recovered and not candidate.continuity_recovered:
            regressions.append("CONTINUITY_REGRESSED_FROM_LKG")
        if previous.product_quality_recovered and not candidate.product_quality_recovered:
            regressions.append("PRODUCT_QUALITY_REGRESSED_FROM_LKG")
        if candidate.user_orchestration_touches > previous.user_orchestration_touches:
            regressions.append("USER_BURDEN_REGRESSED_FROM_LKG")
        if candidate.main_manual_dispatches > previous.main_manual_dispatches:
            regressions.append("MAIN_DISPATCH_BURDEN_REGRESSED_FROM_LKG")
        if candidate.duplicate_writers > previous.duplicate_writers:
            regressions.append("WRITER_DUPLICATION_REGRESSED_FROM_LKG")
        if previous.spend_known and candidate.spend_known and candidate.new_spend > previous.new_spend:
            regressions.append("SPEND_REGRESSED_FROM_LKG")

    combined = tuple(sorted(set((*reasons, *regressions))))
    allowed = not combined
    if allowed:
        action = PromotionAction.PROMOTE
        truth_state = TruthState.VERIFIED_COMPLETE
        rollback_target = previous_result_ref
    elif "DUPLICATE_WRITER_DETECTED" in combined or "ROLLBACK_UNAVAILABLE" in combined:
        action = PromotionAction.QUARANTINE
        truth_state = TruthState.BLOCKED
        rollback_target = previous_result_ref
    elif regressions and previous is not None:
        action = PromotionAction.ROLLBACK
        truth_state = TruthState.VERIFIED_PARTIAL
        rollback_target = previous_result_ref
    elif "TERMINAL_READBACK_NOT_VERIFIED" in combined:
        action = PromotionAction.BLOCK
        truth_state = TruthState.ACKNOWLEDGED_NOT_VERIFIED
        rollback_target = previous_result_ref
    else:
        action = PromotionAction.KEEP_LAST_KNOWN_GOOD
        truth_state = TruthState.VERIFIED_PARTIAL
        rollback_target = previous_result_ref

    material = {
        "allowed": allowed,
        "action": action.value,
        "truth_state": truth_state.value,
        "baseline_id": baseline.baseline_id,
        "candidate_id": candidate.candidate_id,
        "reasons": list(combined),
        "regressions": list(sorted(set(regressions))),
        "rollback_target": rollback_target,
    }
    return PromotionDecision(
        allowed=allowed,
        action=action,
        truth_state=truth_state,
        baseline_id=baseline.baseline_id,
        candidate_id=candidate.candidate_id,
        reasons=combined,
        regressions=tuple(sorted(set(regressions))),
        rollback_target=rollback_target,
        decision_sha256=_sha256(material),
    )


class LastKnownGoodStore:
    """Atomic last-known-good state kept outside chat history."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def path(self, scope: str) -> Path:
        normalized = scope.strip()
        if not normalized:
            raise ValueError("scope must be non-empty")
        return self.root / "quality" / f"{_sha256(normalized)[:24]}.json"

    def load(self, scope: str) -> dict[str, object] | None:
        target = self.path(scope)
        if not target.exists():
            return None
        raw = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise BaselineIntegrityError("last-known-good root must be an object")
        if raw.get("schema_version") != SCHEMA_VERSION:
            raise BaselineIntegrityError("unsupported last-known-good schema")
        recorded = raw.get("state_sha256")
        material = copy.deepcopy(raw)
        material["state_sha256"] = ""
        if not isinstance(recorded, str) or recorded != _sha256(material):
            raise BaselineIntegrityError("last-known-good state hash mismatch")
        baseline_raw = raw.get("baseline")
        snapshot_raw = raw.get("active_snapshot")
        if not isinstance(baseline_raw, Mapping) or not isinstance(snapshot_raw, Mapping):
            raise BaselineIntegrityError("last-known-good record is incomplete")
        baseline = parse_baseline(baseline_raw)
        snapshot = parse_snapshot(snapshot_raw)
        if baseline.scope != scope.strip():
            raise BaselineIntegrityError("last-known-good scope mismatch")
        return {
            "schema_version": SCHEMA_VERSION,
            "scope": baseline.scope,
            "baseline": baseline.to_dict(),
            "active_snapshot": snapshot.to_dict(),
            "active_result_ref": raw.get("active_result_ref"),
            "previous_snapshot": raw.get("previous_snapshot"),
            "previous_result_ref": raw.get("previous_result_ref"),
            "updated_at": raw.get("updated_at"),
            "state_sha256": recorded,
        }

    def active_snapshot(self, scope: str) -> tuple[QualitySnapshot | None, str | None]:
        record = self.load(scope)
        if record is None:
            return None, None
        raw_snapshot = record.get("active_snapshot")
        if not isinstance(raw_snapshot, Mapping):
            raise BaselineIntegrityError("active snapshot missing")
        result_ref = record.get("active_result_ref")
        if result_ref is not None and not isinstance(result_ref, str):
            raise BaselineIntegrityError("active_result_ref must be string or null")
        return parse_snapshot(raw_snapshot), result_ref

    def promote(
        self,
        baseline: QualityBaseline,
        snapshot: QualitySnapshot,
        decision: PromotionDecision,
        *,
        result_ref: str,
    ) -> dict[str, object]:
        if not decision.allowed or decision.action != PromotionAction.PROMOTE:
            raise ValueError("only an allowed PROMOTE decision may update last-known-good")
        if decision.baseline_id != baseline.baseline_id:
            raise ValueError("promotion decision baseline mismatch")
        if decision.candidate_id != snapshot.candidate_id:
            raise ValueError("promotion decision candidate mismatch")
        previous = self.load(baseline.scope)
        state: dict[str, object] = {
            "schema_version": SCHEMA_VERSION,
            "scope": baseline.scope,
            "baseline": baseline.to_dict(),
            "active_snapshot": snapshot.to_dict(),
            "active_result_ref": result_ref,
            "previous_snapshot": previous.get("active_snapshot") if previous is not None else None,
            "previous_result_ref": previous.get("active_result_ref") if previous is not None else None,
            "updated_at": _now(),
            "decision": decision.to_dict(),
            "state_sha256": "",
        }
        state["state_sha256"] = _sha256(state)
        target = self.path(baseline.scope)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        payload = json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        with temp.open("w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, target)
        loaded = self.load(baseline.scope)
        assert loaded is not None
        return loaded
