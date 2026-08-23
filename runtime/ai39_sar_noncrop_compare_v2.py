from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping

from ai39_sar_noncrop_morphology import (
    SCHEMA_COMPARE,
    SCHEMA_YEAR,
    atomic_write,
    seal,
    utc_now,
    validate_seal,
)

MIN_MEASURED_PAIRS = 3


def classify(current: Mapping[str, Any], historical: Mapping[str, Any]) -> dict[str, Any]:
    c_pairs = int(current.get("measured_pairs", 0))
    h_pairs = int(historical.get("measured_pairs", 0))
    c_repeat = float(current.get("structural_repeat_percent", 0.0))
    h_repeat = float(historical.get("structural_repeat_percent", 0.0))
    c_enrichment = float(current.get("structural_vs_crop_enrichment", 0.0))
    components = int(current.get("robust_component_count", 0))
    max_pixels = int(current.get("max_component_pixels", 0))
    elongated = int(current.get("elongated_component_count", 0))

    if min(c_pairs, h_pairs) < MIN_MEASURED_PAIRS:
        state = "INSUFFICIENT_DATA"
        reason = "Fewer than three usable independent pair geometries in at least one year."
    elif (
        c_repeat >= max(0.15, 2.0 * h_repeat + 0.08)
        and c_enrichment >= 1.5
        and components >= 1
        and max_pixels >= 6
    ):
        state = "UNRESOLVED_NONCROP_REPEAT_LEAD"
        reason = "Current non-crop repeat exceeds the seasonal control and crop background on multiple usable pairs."
    elif c_repeat <= h_repeat + 0.08 or components == 0 or max_pixels < 6:
        state = "NO_NONCROP_ESCALATION"
        reason = "No sufficiently robust current non-crop component exceeds the seasonal control."
    else:
        state = "WEAK_NONCROP_DIFFERENCE"
        reason = "A current difference exists but fails one or more independence, enrichment or component-size gates."

    usable_elongation = (
        float(current.get("max_component_elongation", 0.0)) if max_pixels >= 6 else None
    )
    return {
        "sector": current.get("sector"),
        "state": state,
        "reason": reason,
        "measured_pairs_2026": c_pairs,
        "measured_pairs_2025": h_pairs,
        "structural_repeat_percent_2026": round(c_repeat, 4),
        "structural_repeat_percent_2025": round(h_repeat, 4),
        "structural_repeat_delta_pp": round(c_repeat - h_repeat, 4),
        "structural_repeat_ratio": round((c_repeat + 0.01) / (h_repeat + 0.01), 3),
        "structural_vs_crop_enrichment_2026": round(c_enrichment, 3),
        "robust_component_count_2026": components,
        "elongated_component_count_2026": elongated,
        "max_component_pixels_2026": max_pixels,
        "max_component_elongation_2026": usable_elongation,
        "quality_gate": {
            "minimum_pairs_each_year": MIN_MEASURED_PAIRS,
            "minimum_component_pixels": 6,
            "minimum_structural_repeat_percent": 0.15,
            "minimum_current_vs_historical_margin_pp": 0.08,
            "minimum_structural_vs_crop_enrichment": 1.5,
        },
        "interpretation": (
            "Aggregate morphology at approximately 40–60 m working scale. This is not trench, "
            "equipment, person or position detection and cannot establish cause."
        ),
    }


def compare(current_path: str | Path, historical_path: str | Path, out_path: str | Path) -> None:
    current = json.loads(Path(current_path).read_text(encoding="utf-8"))
    historical = json.loads(Path(historical_path).read_text(encoding="utf-8"))
    if current.get("schema_version") != SCHEMA_YEAR or historical.get("schema_version") != SCHEMA_YEAR:
        raise ValueError("invalid year result")
    validate_seal(current, "result_sha256")
    validate_seal(historical, "result_sha256")
    if int(current.get("year")) != 2026 or int(historical.get("year")) != 2025:
        raise ValueError("expected 2026 current and 2025 historical")

    current_by_sector = {item["sector"]: item for item in current["sector_summary"]}
    historical_by_sector = {item["sector"]: item for item in historical["sector_summary"]}
    comparisons = [
        classify(current_by_sector[sector], historical_by_sector[sector])
        for sector in sorted(current_by_sector)
        if sector in historical_by_sector
    ]
    order = {
        "UNRESOLVED_NONCROP_REPEAT_LEAD": 3,
        "WEAK_NONCROP_DIFFERENCE": 2,
        "NO_NONCROP_ESCALATION": 1,
        "INSUFFICIENT_DATA": 0,
    }
    comparisons.sort(
        key=lambda item: (
            order.get(str(item["state"]), -1),
            float(item["structural_repeat_delta_pp"]),
            int(item["robust_component_count_2026"]),
        ),
        reverse=True,
    )
    d4 = next(item for item in comparisons if item["sector"] == "D4")
    if d4["state"] == "UNRESOLVED_NONCROP_REPEAT_LEAD":
        conclusion = (
            "D4 survives the hardened non-crop morphology control as an unresolved lead; "
            "independent RF/VHR/document evidence remains mandatory."
        )
    elif d4["state"] == "NO_NONCROP_ESCALATION":
        conclusion = (
            "D4 does not show a sufficiently robust novel non-crop morphology versus 2025; "
            "do not promote organized-presence confidence."
        )
    elif d4["state"] == "INSUFFICIENT_DATA":
        conclusion = (
            "D4 morphology remains insufficient because the independent-pair depth did not pass the quality floor."
        )
    else:
        conclusion = (
            "D4 remains weak: current morphology does not distinguish organized activity from non-military processes."
        )

    preliminary_audit = {
        "status": "REJECTED_AS_PREMATURE",
        "reason": (
            "The first comparison used only two usable pairs per year and could over-promote tiny components. "
            "Version 2 requires at least three usable independent pairs and a six-pixel component floor."
        ),
    }
    result: dict[str, Any] = {
        "schema_version": SCHEMA_COMPARE,
        "comparison_version": "V2_HARDENED",
        "generated_at": utc_now(),
        "status": "MEASURED",
        "scope": "AI-39 broad 4x4 aggregate comparison only; no component coordinates or target-level output.",
        "current_year": 2026,
        "historical_control_year": 2025,
        "preliminary_v1_audit": preliminary_audit,
        "comparisons": comparisons,
        "d4": d4,
        "d4_conclusion": conclusion,
        "top_followups": comparisons[:6],
        "next_gap": (
            "Pursue only sectors surviving the hardened gate using independent broad RF, VHR "
            "single-scene/matched imagery, or entity/document corroboration."
        ),
        "result_sha256": "",
    }
    seal(result, "result_sha256")
    atomic_write(out_path, result)
    print(json.dumps({"d4": d4, "d4_conclusion": conclusion, "top_followups": comparisons[:6]}, ensure_ascii=False, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Hardened AI-39 SAR morphology comparison")
    parser.add_argument("--current", required=True)
    parser.add_argument("--historical", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    compare(args.current, args.historical, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
