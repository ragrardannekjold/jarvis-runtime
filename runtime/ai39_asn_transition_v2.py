from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any, Mapping

from ai39_asn_transition import atomic_write, digest, utc_now

SCHEMA = "AI39_ASN_TRANSITION_V0_2"


def as_string_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item).strip().casefold() for item in value if str(item).strip()}


def exact_org_relationship(result: Mapping[str, Any]) -> dict[str, Any]:
    ripe = result.get("ripe", {})
    legacy = ripe.get("legacy", {}) if isinstance(ripe, Mapping) else {}
    phoenix = ripe.get("phoenix", {}) if isinstance(ripe, Mapping) else {}
    legacy_fields = (
        legacy.get("whois", {}).get("fields", {}) if isinstance(legacy, Mapping) else {}
    )
    phoenix_fields = (
        phoenix.get("whois", {}).get("fields", {}) if isinstance(phoenix, Mapping) else {}
    )
    legacy_orgs = as_string_set(legacy_fields.get("org", [])) if isinstance(legacy_fields, Mapping) else set()
    phoenix_orgs = as_string_set(phoenix_fields.get("org", [])) if isinstance(phoenix_fields, Mapping) else set()
    common_orgs = sorted(legacy_orgs & phoenix_orgs)
    legacy_names = as_string_set(legacy_fields.get("as-name", [])) if isinstance(legacy_fields, Mapping) else set()
    phoenix_names = as_string_set(phoenix_fields.get("as-name", [])) if isinstance(phoenix_fields, Mapping) else set()
    return {
        "same_ripe_org": bool(common_orgs),
        "common_ripe_orgs": common_orgs,
        "legacy_as_names": sorted(legacy_names),
        "phoenix_as_names": sorted(phoenix_names),
        "same_broad_operator_family_lead": bool(common_orgs),
        "confidence": 0.92 if common_orgs else 0.25,
        "statement": (
            "RIPE assigns both AS202279 and AS214721 to the same organisation object."
            if common_orgs
            else "RIPE organisation identity does not establish a shared operator family."
        ),
        "interpretation_limit": (
            "A shared RIPE organisation object establishes registration-level relationship only. "
            "It does not prove that a specific service, device or physical site moved between ASNs."
        ),
    }


def monthly_map(trend: Any) -> dict[str, int]:
    if not isinstance(trend, Mapping):
        return {}
    output: dict[str, int] = {}
    for item in trend.get("monthly", []) if isinstance(trend.get("monthly", []), list) else []:
        if not isinstance(item, Mapping):
            continue
        month = item.get("month")
        count = item.get("count")
        if isinstance(month, str) and isinstance(count, int):
            output[month] = count
    return output


def collapse_ratio(january: int | None, march: int | None) -> float | None:
    if not isinstance(january, int) or not isinstance(march, int) or january <= 0:
        return None
    return round(max(0.0, min(1.0, (january - march) / january)), 4)


def assess(result: Mapping[str, Any], relationship: Mapping[str, Any]) -> dict[str, Any]:
    shodan = result.get("shodan", {})
    legacy = shodan.get("legacy", {}) if isinstance(shodan, Mapping) else {}
    phoenix = shodan.get("phoenix", {}) if isinstance(shodan, Mapping) else {}
    phoenix_trend = monthly_map(
        shodan.get("phoenix_trend", {}) if isinstance(shodan, Mapping) else {}
    )
    prior = result.get("prior_verified_legacy_trend", {})
    legacy_trend = (
        prior.get("monthly_2026", {}) if isinstance(prior, Mapping) else {}
    )

    old_total = legacy.get("current_total") if isinstance(legacy, Mapping) else None
    new_total = phoenix.get("current_total") if isinstance(phoenix, Mapping) else None
    old_jan = legacy_trend.get("2026-01") if isinstance(legacy_trend, Mapping) else None
    old_mar = legacy_trend.get("2026-03") if isinstance(legacy_trend, Mapping) else None
    new_jan = phoenix_trend.get("2026-01")
    new_mar = phoenix_trend.get("2026-03")
    old_collapse = collapse_ratio(old_jan, old_mar)
    new_collapse = collapse_ratio(new_jan, new_mar)
    same_org = bool(relationship.get("same_ripe_org"))

    if (
        same_org
        and isinstance(old_collapse, float)
        and isinstance(new_collapse, float)
        and old_collapse >= 0.70
        and new_collapse >= 0.70
    ):
        state = "SUPPORTED_OPERATOR_WIDE_EXPOSURE_POLICY_OR_RESTRUCTURING"
        confidence = 0.84
        migration_state = "NOT_SUPPORTED_BY_CURRENT_EXPOSURE"
        statement = (
            "Both ASNs assigned to the same RIPE organisation show a synchronized Jan-to-Mar 2026 "
            "collapse in Shodan-indexed exposure while both remain routed. This supports an operator-wide "
            "firewall/NAT/exposure-policy or infrastructure-restructuring event more strongly than a "
            "simple service migration from the legacy ASN to Phoenix."
        )
    elif same_org and isinstance(old_total, int) and isinstance(new_total, int):
        state = "UNRESOLVED_DUAL_ASN_RESTRUCTURING"
        confidence = 0.66
        migration_state = (
            "POSSIBLE_ROLE_SPLIT"
            if new_total > 0 and old_total > 0
            else "INSUFFICIENT_CURRENT_EXPOSURE"
        )
        statement = (
            "The ASNs share a RIPE organisation and both remain observable, but the temporal evidence "
            "does not distinguish role split, migration or exposure-policy change."
        )
    elif same_org:
        state = "UNRESOLVED_RIPE_RELATION_ONLY"
        confidence = 0.55
        migration_state = "INSUFFICIENT_EXPOSURE_DATA"
        statement = (
            "The shared RIPE organisation is verified, but current passive exposure data is incomplete."
        )
    else:
        state = "INSUFFICIENT_RELATIONSHIP_EVIDENCE"
        confidence = 0.30
        migration_state = "NOT_ASSESSED"
        statement = "Available metadata does not establish a reliable relationship between the ASNs."

    current_ratio = None
    if isinstance(old_total, int) and isinstance(new_total, int):
        current_ratio = round((new_total + 1) / (old_total + 1), 3)

    ripe = result.get("ripe", {})
    legacy_ripe = ripe.get("legacy", {}) if isinstance(ripe, Mapping) else {}
    phoenix_ripe = ripe.get("phoenix", {}) if isinstance(ripe, Mapping) else {}
    return {
        "state": state,
        "confidence": confidence,
        "statement": statement,
        "migration_hypothesis": migration_state,
        "current_total_legacy": old_total,
        "current_total_phoenix": new_total,
        "phoenix_to_legacy_current_ratio": current_ratio,
        "legacy_jan_to_mar_collapse_fraction": old_collapse,
        "phoenix_jan_to_mar_collapse_fraction": new_collapse,
        "legacy_announced_prefix_count": legacy_ripe.get("announced_prefix_count") if isinstance(legacy_ripe, Mapping) else None,
        "phoenix_announced_prefix_count": phoenix_ripe.get("announced_prefix_count") if isinstance(phoenix_ripe, Mapping) else None,
        "alternative_explanations": [
            "coordinated Shodan crawl/indexing changes across the same operator",
            "operator-wide NAT/firewall or service-exposure policy change",
            "reorganization with parallel mobile and fixed-network roles",
            "service centralization outside both publicly indexed surfaces",
            "physical infrastructure restructuring without service migration",
        ],
        "does_not_establish": [
            "people or equipment presence in a specific sector",
            "military use of a specific device or service",
            "exact network nodes or physical locations",
            "current surveillance or detection coverage",
        ],
    }


def harden(input_path: str | Path, output_path: str | Path) -> None:
    raw = json.loads(Path(input_path).read_text(encoding="utf-8"))
    if raw.get("schema_version") != "AI39_ASN_TRANSITION_V0_1":
        raise ValueError("unexpected input schema")
    output = copy.deepcopy(raw)
    output["schema_version"] = SCHEMA
    output["hardened_at"] = utc_now()
    output["preliminary_v1_audit"] = {
        "status": "REJECTED_AS_RELATIONSHIP_LOGIC_DEFECT",
        "reason": (
            "V1 required free-text Donetsk markers and failed to recognize that both ASNs share "
            "the exact RIPE organisation object ORG-SUEO4-RIPE."
        ),
    }
    relationship = exact_org_relationship(output)
    output["relationship"] = relationship
    output["transition_assessment"] = assess(output, relationship)
    output["next_gap"] = (
        "Treat the synchronized collapse as a broad operator-wide restructuring lead. Correlate with "
        "official reorganization, procurement/integrator, RF-provider and VHR evidence. Do not enumerate hosts."
    )
    output["result_sha256"] = ""
    output["result_sha256"] = digest(output)
    atomic_write(output_path, output)
    print(
        json.dumps(
            {
                "relationship": relationship,
                "transition_assessment": output["transition_assessment"],
                "preliminary_v1_audit": output["preliminary_v1_audit"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Harden AI-39 ASN transition inference")
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    harden(args.input, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
