#!/usr/bin/env python3
"""Fail-closed contract for a shadow ballistic-capability disruption feature.

The feature records whether evidence is qualified for later calibration.  It
never changes an official alert or applies a numeric risk reduction while the
registry status is UNTESTED.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


FEATURE_ID = "BAL_VERIFIED_LAUNCH_CAPABILITY_DISRUPTION"
HORIZONS_MINUTES = (360, 180, 60)
REGISTRY_STATES = frozenset({"UNTESTED", "CONDITIONAL", "VERIFIED"})
GATE_STATES = frozenset({"PASS", "FAIL", "UNKNOWN"})
DIRECT_TARGET_CLASSES = frozenset({
    "BALLISTIC_TEL",
    "TRANSPORT_LOADER",
    "BALLISTIC_C2",
    "READY_MUNITIONS",
})
FUNCTIONAL_EFFECTS = frozenset({"ASSET_DISABLED", "LAUNCH_ABORT_CONFIRMED"})


def _utc(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _gate(state: str, reason: str) -> dict[str, str]:
    return {"state": state, "reason": reason}


def default_suppression_state() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "feature_id": FEATURE_ID,
        "registry_status": "UNTESTED",
        "evidence_state": "UNKNOWN",
        "horizons_minutes": list(HORIZONS_MINUTES),
        "applicable_regions": [],
        "gates": {
            "source": _gate("UNKNOWN", "NO_CURRENT_FUNCTIONAL_BDA_INGESTED"),
            "operational_disruption": _gate("UNKNOWN", "NO_CURRENT_FUNCTIONAL_BDA_INGESTED"),
            "scope_relevance": _gate("UNKNOWN", "NO_CURRENT_FUNCTIONAL_BDA_INGESTED"),
            "time_validity": _gate("UNKNOWN", "NO_CURRENT_FUNCTIONAL_BDA_INGESTED"),
            "calibration": _gate("FAIL", "FEATURE_UNTESTED"),
        },
        "effect": {
            "mode": "NO_EFFECT",
            "applied_delta_points": 0,
            "may_affect": ["READINESS", "PREPARATION"],
            "never_affects": ["CAPACITY", "OFFICIAL_ACTIVE", "5M", "15M", "30M"],
            "civilian_action_override_allowed": False,
        },
        "official_threat_override": False,
        "execution_debt": "HISTORICAL_MATCHED_BACKTEST_NOT_DONE",
    }


def evaluate_suppression_evidence(
    evidence: dict[str, Any],
    *,
    anchor_utc: str,
    expected_run_id: str | None = None,
) -> dict[str, Any]:
    """Return a qualitative shadow state; fail closed on every missing gate.

    Required independent lineages must be named at aggregate source-family
    level.  Exact coordinates are rejected.  Eligibility uses public-observed
    time, not the earlier physical event time, to prevent hindsight leakage.
    """
    state = default_suppression_state()
    registry_status = str(evidence.get("registry_status", "UNTESTED"))
    state["registry_status"] = registry_status if registry_status in REGISTRY_STATES else "UNTESTED"
    official_override = bool(evidence.get("official_active_warning") or evidence.get("fresh_launch_evidence"))
    state["official_threat_override"] = official_override

    if any(key in evidence for key in ("coordinates", "latitude", "longitude", "bbox")):
        state["evidence_state"] = "REJECTED"
        state["gates"]["scope_relevance"] = _gate("FAIL", "PRECISE_LOCATION_FIELDS_FORBIDDEN")
        return state

    lineages = evidence.get("independent_source_lineages")
    if isinstance(lineages, list):
        clean_lineages = {str(item).strip() for item in lineages if str(item).strip()}
    else:
        clean_lineages = set()
    run_linked = expected_run_id is None or evidence.get("run_id") == expected_run_id
    source_pass = (
        len(clean_lineages) >= 2
        and bool(evidence.get("stable_primary_functional_assessment"))
        and bool(evidence.get("source_independence_verified"))
        and run_linked
    )
    state["gates"]["source"] = _gate(
        "PASS" if source_pass else "UNKNOWN",
        "TWO_INDEPENDENT_PRIMARY_LINEAGES_AND_RUN_LINK" if source_pass else "INDEPENDENT_FUNCTIONAL_CONFIRMATION_OR_RUN_LINK_MISSING",
    )

    target_class = str(evidence.get("target_class", "UNKNOWN"))
    effect_status = str(evidence.get("effect_status", "STRIKE_REPORTED"))
    disruption_pass = target_class in DIRECT_TARGET_CLASSES and effect_status in FUNCTIONAL_EFFECTS
    state["gates"]["operational_disruption"] = _gate(
        "PASS" if disruption_pass else "UNKNOWN",
        "FUNCTIONAL_LAUNCH_CHAIN_INTERRUPTION" if disruption_pass else "STRIKE_OR_HIT_WITHOUT_FUNCTIONAL_MISSION_KILL",
    )

    region_bucket = str(evidence.get("region_bucket", "")).strip()
    scope_pass = bool(region_bucket) and bool(evidence.get("kyiv_capable_scope")) and bool(evidence.get("material_regional_scope"))
    state["gates"]["scope_relevance"] = _gate(
        "PASS" if scope_pass else "UNKNOWN",
        "KYIV_CAPABLE_REGIONAL_SCOPE" if scope_pass else "KYIV_RELEVANCE_OR_REDUNDANCY_UNRESOLVED",
    )

    anchor = _utc(anchor_utc)
    observed = _utc(evidence.get("public_observed_time_utc"))
    effect_readback = _utc(evidence.get("effect_readback_time_utc"))
    time_pass = bool(
        anchor
        and observed
        and effect_readback
        and observed <= effect_readback <= anchor
        and 0 <= (anchor - observed).total_seconds() <= 6 * 3600
    )
    state["gates"]["time_validity"] = _gate(
        "PASS" if time_pass else "UNKNOWN",
        "CURRENT_WITHIN_0_6H_AND_READ_BACK" if time_pass else "CURRENT_EFFECT_WINDOW_NOT_VERIFIED",
    )

    magnitude = evidence.get("frozen_effect_magnitude")
    magnitude_valid = isinstance(magnitude, int) and not isinstance(magnitude, bool) and magnitude < 0
    calibration_pass = state["registry_status"] in {"CONDITIONAL", "VERIFIED"} and magnitude_valid and bool(evidence.get("chronological_holdout_passed"))
    state["gates"]["calibration"] = _gate(
        "PASS" if calibration_pass else "FAIL",
        "FROZEN_HOLDOUT_VALIDATED_EFFECT" if calibration_pass else "UNTESTED_OR_NO_FROZEN_HOLDOUT_EFFECT",
    )

    evidence_gates = ("source", "operational_disruption", "scope_relevance", "time_validity")
    evidence_pass = all(state["gates"][name]["state"] == "PASS" for name in evidence_gates)
    if any(state["gates"][name]["state"] == "FAIL" for name in evidence_gates):
        state["evidence_state"] = "REJECTED"
    elif evidence_pass and not calibration_pass:
        state["evidence_state"] = "QUALIFIED_UNTESTED"
        state["applicable_regions"] = [region_bucket]
        state["effect"]["mode"] = "SHADOW_ONLY"
    elif evidence_pass and calibration_pass:
        state["evidence_state"] = "VERIFIED_DONE"
        state["applicable_regions"] = [region_bucket]
        state["effect"]["mode"] = "BOUNDED_LOCAL_MODIFIER"
    else:
        state["evidence_state"] = "UNKNOWN"

    blocked = (
        official_override
        or not evidence_pass
        or not calibration_pass
        or evidence.get("observability") != "STABLE"
        or evidence.get("substitution") != "NONE_SEEN"
        or evidence.get("retaliation_signal", "NONE") != "NONE"
    )
    if blocked:
        state["effect"]["applied_delta_points"] = 0
        if official_override:
            state["effect"]["mode"] = "OVERRIDDEN_BY_FRESH_THREAT_EVIDENCE"
    else:
        # Magnitude belongs to a future frozen model; the contract never invents it.
        state["effect"]["applied_delta_points"] = magnitude
    return state


def validate_suppression_state(state: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if state.get("feature_id") != FEATURE_ID:
        errors.append("FEATURE_ID_MISMATCH")
    if state.get("horizons_minutes") != list(HORIZONS_MINUTES):
        errors.append("INVALID_HORIZONS")
    if state.get("registry_status") not in REGISTRY_STATES:
        errors.append("INVALID_REGISTRY_STATUS")
    gates = state.get("gates")
    if not isinstance(gates, dict):
        errors.append("GATES_MISSING")
        gates = {}
    for name in ("source", "operational_disruption", "scope_relevance", "time_validity", "calibration"):
        gate = gates.get(name)
        if not isinstance(gate, dict) or gate.get("state") not in GATE_STATES:
            errors.append(f"INVALID_GATE_{name.upper()}")
    effect = state.get("effect")
    if not isinstance(effect, dict):
        errors.append("EFFECT_MISSING")
        effect = {}
    delta = effect.get("applied_delta_points")
    if not isinstance(delta, int):
        errors.append("DELTA_NOT_INTEGER")
    if state.get("registry_status") == "UNTESTED" and delta != 0:
        errors.append("UNTESTED_NONZERO_DELTA")
    if state.get("official_threat_override") and delta != 0:
        errors.append("OFFICIAL_OVERRIDE_NONZERO_DELTA")
    if state.get("evidence_state") in {"UNKNOWN", "REJECTED", "QUALIFIED_UNTESTED"} and delta != 0:
        errors.append("UNQUALIFIED_NONZERO_DELTA")
    if effect.get("civilian_action_override_allowed") is True:
        errors.append("CIVILIAN_ACTION_OVERRIDE_FORBIDDEN")
    return errors
