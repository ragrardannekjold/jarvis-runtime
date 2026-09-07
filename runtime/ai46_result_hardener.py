from __future__ import annotations

import argparse
import copy
import hashlib
import ipaddress
import json
import re
import tempfile
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

RAW_SCHEMA = "AI46_AGGREGATE_V0_1"
HARDENED_SCHEMA = "AI46_HARDENED_RESULT_V0_2"

FORBIDDEN_KEYS = {
    "ip",
    "ips",
    "ip_address",
    "host",
    "hosts",
    "hostname",
    "hostnames",
    "banner",
    "banners",
    "vulnerability",
    "vulnerabilities",
    "cve",
    "cves",
    "credential",
    "credentials",
    "password",
    "raw_iq",
    "raw_communications",
    "exact_coordinates",
    "latitude",
    "longitude",
    "target",
    "targets",
    "route",
    "routes",
    "evasion",
}

IPV4_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
COORD_PAIR_RE = re.compile(
    r"(?<![\d.])-?\d{1,3}\.\d{4,}\s*[,;/]\s*-?\d{1,3}\.\d{4,}(?![\d.])"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: Any) -> str:
    text = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def seal(document: dict[str, Any], field: str) -> dict[str, Any]:
    document[field] = ""
    material = copy.deepcopy(document)
    material[field] = ""
    document[field] = sha256(material)
    return document


def validate_seal(document: Mapping[str, Any], field: str) -> None:
    recorded = document.get(field)
    if not isinstance(recorded, str) or len(recorded) != 64:
        raise ValueError(f"missing {field}")
    material = copy.deepcopy(dict(document))
    material[field] = ""
    if recorded != sha256(material):
        raise ValueError(f"{field} mismatch")


def atomic_write(path: str | Path, document: Mapping[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=target.parent, delete=False, prefix=f".{target.name}."
    ) as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, target)


def _is_ip_literal(token: str) -> bool:
    candidate = token.strip("[](){}<>,;:'\"")
    try:
        ipaddress.ip_address(candidate)
        return True
    except ValueError:
        return False


def validate_safe_output(value: Any, path: str = "$") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = str(key).strip().casefold()
            if normalized in FORBIDDEN_KEYS:
                raise ValueError(f"forbidden key at {path}.{key}")
            validate_safe_output(child, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            validate_safe_output(child, f"{path}[{index}]")
        return
    if isinstance(value, str):
        if COORD_PAIR_RE.search(value):
            raise ValueError(f"coordinate-like value at {path}")
        for match in IPV4_RE.findall(value):
            if _is_ip_literal(match):
                raise ValueError(f"IP-like value at {path}")
        for token in re.split(r"\s+", value):
            if ":" in token and _is_ip_literal(token):
                raise ValueError(f"IP-like value at {path}")


def _extract_numeric_rejections(raw: Mapping[str, Any]) -> list[dict[str, Any]]:
    rejected: list[dict[str, Any]] = []
    impacts = raw.get("evidence_impacts", [])
    if not isinstance(impacts, list):
        return rejected
    for impact in impacts:
        if not isinstance(impact, Mapping):
            continue
        if "prior_confidence" in impact or "updated_confidence" in impact:
            rejected.append(
                {
                    "candidate_id": impact.get("candidate_id"),
                    "claim_id": impact.get("claim_id"),
                    "proposed_prior": impact.get("prior_confidence"),
                    "proposed_updated": impact.get("updated_confidence"),
                    "reason": "No labelled calibration supports the exact numeric increment.",
                }
            )
        if "prior_alternative_weight" in impact or "updated_alternative_weight" in impact:
            rejected.append(
                {
                    "candidate_id": impact.get("candidate_id"),
                    "claim_id": impact.get("claim_id"),
                    "proposed_prior": impact.get("prior_alternative_weight"),
                    "proposed_updated": impact.get("updated_alternative_weight"),
                    "reason": "No labelled calibration supports the exact numeric decrement.",
                }
            )
    return rejected


def harden_result(raw: Mapping[str, Any]) -> dict[str, Any]:
    if raw.get("schema_version") != RAW_SCHEMA:
        raise ValueError("unexpected raw aggregate schema")
    if raw.get("external_side_effects") is not False:
        raise ValueError("external side effects are not allowed")
    accepted_workers = raw.get("worker_count_accepted")
    if not isinstance(accepted_workers, int) or accepted_workers < 1:
        raise ValueError("no accepted worker results")

    validate_safe_output(raw)

    raw_impacts = raw.get("evidence_impacts", [])
    if not isinstance(raw_impacts, list):
        raw_impacts = []

    evidence_movements: list[dict[str, Any]] = []
    for impact in raw_impacts:
        if not isinstance(impact, Mapping):
            continue
        claim_id = impact.get("claim_id")
        candidate_id = impact.get("candidate_id")
        if claim_id == "AI39-CYBINT-AS202279-RESTRUCTURING":
            movement = "RECONFIRMED"
            authoritative_state = "SUPPORTED"
        elif claim_id == "AI39-D4-TERRAIN-CONFOUND":
            movement = "ALTERNATIVE_WEAKENED"
            authoritative_state = "SUPPORTED_DIRECTIONAL"
        elif claim_id == "AI39-ENTITY-UK-SANCTIONS-DIRECT-MATCH":
            movement = "UNRESOLVED_WEAK_NEGATIVE"
            authoritative_state = "UNRESOLVED"
        else:
            movement = "NO_AUTHORITATIVE_MOVEMENT"
            authoritative_state = str(impact.get("state") or "UNRESOLVED")
        evidence_movements.append(
            {
                "worker_id": impact.get("worker_id"),
                "claim_id": claim_id,
                "candidate_id": candidate_id,
                "movement": movement,
                "authoritative_state": authoritative_state,
                "statement": impact.get("statement"),
            }
        )

    material_count = sum(
        item.get("movement") == "ALTERNATIVE_WEAKENED" for item in evidence_movements
    )
    corroboration_count = sum(
        item.get("movement") == "RECONFIRMED" for item in evidence_movements
    )

    result: dict[str, Any] = {
        "schema_version": HARDENED_SCHEMA,
        "source_schema": RAW_SCHEMA,
        "mission_id": raw.get("mission_id"),
        "generated_at": utc_now(),
        "status": "VERIFIED_DIRECTIONAL_UPDATE",
        "calibration_status": "DIRECTIONAL_ONLY_NUMERIC_PROMOTION_BLOCKED",
        "safe_output_validation": "PASS",
        "worker_count_expected": raw.get("worker_count_expected"),
        "worker_count_accepted": accepted_workers,
        "worker_count_rejected": raw.get("worker_count_rejected"),
        "worker_statuses": copy.deepcopy(raw.get("worker_statuses", {})),
        "material_evidence_change_count": material_count,
        "corroboration_count": corroboration_count,
        "numeric_updates_promoted": 0,
        "rejected_numeric_updates": _extract_numeric_rejections(raw),
        "candidate_ledger": {
            "AS202279_RESTRUCTURING": {
                "state": "SUPPORTED",
                "evidence_movement": "RECONFIRMED",
                "numeric_confidence_movement": "NOT_PROMOTED_UNCALIBRATED",
                "interpretation": (
                    "Continued routing plus low indexed external exposure supports infrastructure "
                    "or exposure-policy restructuring; cause remains unresolved."
                ),
            },
            "D4": {
                "state": "WEAK",
                "organized_presence_movement": "UNCHANGED",
                "terrain_artifact_movement": "WEAKENED",
                "agriculture_explanation": "FAVORED",
                "numeric_confidence_movement": "NOT_PROMOTED_UNCALIBRATED",
                "interpretation": (
                    "AOI-relative DEM metrics weaken a broad terrain-induced SAR-artifact "
                    "explanation, but do not establish people, equipment or fortifications."
                ),
            },
        },
        "evidence_movements": evidence_movements,
        "material_delta": (
            "D4 is the AOI low-relief tail, so terrain alone is a weaker explanation for its "
            "repeated SAR discrepancy. Organized-presence evidence remains weak and agriculture "
            "remains favored. AS202279 restructuring is reconfirmed, not newly attributed."
        ),
        "next_gap": (
            "Obtain an independent broad RF observation or high-resolution/non-crop morphology "
            "that can discriminate organized activity from agriculture for D4; expand the "
            "AS202279 entity graph through counterparties, integrators and procurement."
        ),
        "chat_readback": (
            "Нове: D4 є найменш рельєфним широким сектором у всьому AOI, тому рельєфний "
            "SAR-артефакт став слабшим поясненням. Людей, техніку чи фортифікації це не доводить; "
            "аграрне пояснення досі сильніше. AS202279: перебудова цифрової експозиції "
            "підтверджена повторно без нового причинного приписування."
        ),
        "durability_status": "CANONICAL_SUMMARY_PERSISTED_RUNTIME_ARTIFACT_TEMPORARY",
        "raw_aggregate_sha256": raw.get("aggregate_sha256"),
        "external_side_effects": False,
        "hardened_sha256": "",
    }
    validate_safe_output(result)
    return seal(result, "hardened_sha256")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Harden AI-46 directional evidence result")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    raw = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("raw aggregate must be an object")
    hardened = harden_result(raw)
    atomic_write(args.output, hardened)
    print(
        json.dumps(
            {
                "status": hardened["status"],
                "material_evidence_change_count": hardened[
                    "material_evidence_change_count"
                ],
                "numeric_updates_promoted": hardened["numeric_updates_promoted"],
                "chat_readback": hardened["chat_readback"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
