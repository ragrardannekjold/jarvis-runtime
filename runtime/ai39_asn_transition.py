from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import requests

SCHEMA = "AI39_ASN_TRANSITION_V0_1"
ASNS = {
    "legacy": "AS202279",
    "phoenix": "AS214721",
}
PRIOR_VERIFIED_LEGACY_TREND = {
    "source": "AI-39 verified Shodan aggregate trends run 32584585221",
    "monthly_2026": {
        "2026-01": 488,
        "2026-02": 107,
        "2026-03": 14,
    },
    "interpretation_limit": (
        "Indexed-service counts are not people, physical presence, unique devices, "
        "ownership proof or operational control."
    ),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def atomic_write(path: str | Path, value: Mapping[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=target.parent, delete=False, prefix=f".{target.name}."
    ) as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
        temp = Path(handle.name)
    os.replace(temp, target)


def get_json(
    url: str,
    *,
    params: Mapping[str, Any] | None = None,
    timeout: float = 45,
    attempts: int = 2,
) -> tuple[dict[str, Any], dict[str, Any]]:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            response = requests.get(
                url,
                params=params,
                timeout=timeout,
                headers={"User-Agent": "AI39-defensive-asn-transition/0.1"},
            )
            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After", "2")
                try:
                    wait = min(max(float(retry_after), 0.5), 20.0)
                except ValueError:
                    wait = 2.0
                if attempt + 1 < attempts:
                    time.sleep(wait)
                    continue
                raise RuntimeError("HTTP 429 provider backpressure")
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise TypeError("JSON response is not an object")
            receipt = {
                "status": "OK",
                "http_status": response.status_code,
                "final_url_host": requests.utils.urlparse(response.url).netloc,
                "response_sha256": hashlib.sha256(response.content).hexdigest(),
                "retrieved_at": utc_now(),
            }
            return payload, receipt
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(1.0 + attempt)
    assert last_error is not None
    raise last_error


def extract_ripe_fields(payload: Mapping[str, Any]) -> dict[str, Any]:
    data = payload.get("data", {})
    records = data.get("records", []) if isinstance(data, Mapping) else []
    allowed = {
        "aut-num",
        "as-name",
        "descr",
        "org",
        "organisation",
        "org-name",
        "org-type",
        "country",
        "mnt-by",
        "mnt-ref",
        "created",
        "last-modified",
        "status",
        "source",
    }
    groups: list[dict[str, str]] = []
    for group in records if isinstance(records, list) else []:
        if not isinstance(group, list):
            continue
        current: dict[str, str] = {}
        for field in group:
            if not isinstance(field, Mapping):
                continue
            key = str(field.get("key") or "").casefold()
            value = str(field.get("value") or "").strip()
            if key in allowed and value:
                if key in current:
                    current[key] = f"{current[key]} | {value}"
                else:
                    current[key] = value
        if current:
            groups.append(current)
    flattened: dict[str, list[str]] = {}
    for group in groups:
        for key, value in group.items():
            flattened.setdefault(key, []).append(value)
    return {
        "groups": groups,
        "fields": {key: sorted(set(values)) for key, values in flattened.items()},
    }


def limited_facets(value: Any, limit: int = 15) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    output: list[dict[str, Any]] = []
    for item in value[:limit]:
        if not isinstance(item, Mapping):
            continue
        facet_value = item.get("value")
        facet_count = item.get("count")
        if isinstance(facet_value, (str, int, float)) and isinstance(facet_count, int):
            output.append({"value": str(facet_value), "count": facet_count})
    return output


def shodan_count(asn: str, key: str) -> tuple[dict[str, Any], dict[str, Any]]:
    payload, receipt = get_json(
        "https://api.shodan.io/shodan/host/count",
        params={
            "key": key,
            "query": f"asn:{asn}",
            "facets": "org:10,port:25,product:15,device:10",
        },
        timeout=60,
        attempts=2,
    )
    facets = payload.get("facets", {}) if isinstance(payload, Mapping) else {}
    return {
        "current_total": payload.get("total"),
        "org_facets": limited_facets(facets.get("org", []) if isinstance(facets, Mapping) else []),
        "port_facets": limited_facets(
            facets.get("port", []) if isinstance(facets, Mapping) else [], 25
        ),
        "product_facets": limited_facets(
            facets.get("product", []) if isinstance(facets, Mapping) else [], 15
        ),
        "device_facets": limited_facets(
            facets.get("device", []) if isinstance(facets, Mapping) else [], 10
        ),
        "query_count": 1,
    }, receipt


def shodan_trend(asn: str, key: str) -> tuple[dict[str, Any], dict[str, Any]]:
    payload, receipt = get_json(
        "https://trends.shodan.io/api/v1/search",
        params={"key": key, "query": f"asn:{asn}"},
        timeout=90,
        attempts=1,
    )
    monthly: list[dict[str, Any]] = []
    for item in payload.get("matches", []) if isinstance(payload, Mapping) else []:
        if not isinstance(item, Mapping):
            continue
        month = item.get("month")
        count = item.get("count")
        if isinstance(month, str) and isinstance(count, (int, float)):
            monthly.append({"month": month, "count": int(count)})
    monthly.sort(key=lambda item: item["month"])
    return {"monthly": monthly[-36:], "trends_total": payload.get("total")}, receipt


def related_operator(legacy: Mapping[str, Any], phoenix: Mapping[str, Any]) -> dict[str, Any]:
    legacy_text = canonical_json(legacy).casefold()
    phoenix_text = canonical_json(phoenix).casefold()
    legacy_markers = ["komtel", "org-sueo4-ripe", "donetsk"]
    phoenix_markers = [
        "republican telecommunications operator",
        "phoenix-as",
        "donetsk",
        "9308013351",
    ]
    return {
        "legacy_marker_hits": [marker for marker in legacy_markers if marker in legacy_text],
        "phoenix_marker_hits": [marker for marker in phoenix_markers if marker in phoenix_text],
        "same_broad_operator_family_lead": (
            "donetsk" in legacy_text
            and "donetsk" in phoenix_text
            and ("komtel" in legacy_text or "org-sueo4-ripe" in legacy_text)
            and (
                "republican telecommunications operator" in phoenix_text
                or "phoenix-as" in phoenix_text
            )
        ),
        "interpretation_limit": (
            "Shared broad entity/region markers establish a relationship lead only; they do not "
            "prove that a particular service, site or device migrated between ASNs."
        ),
    }


def score_transition(result: Mapping[str, Any]) -> dict[str, Any]:
    relation = result.get("relationship", {})
    shodan = result.get("shodan", {})
    old_total = None
    new_total = None
    if isinstance(shodan, Mapping):
        old = shodan.get("legacy", {})
        new = shodan.get("phoenix", {})
        if isinstance(old, Mapping) and isinstance(old.get("current_total"), int):
            old_total = int(old["current_total"])
        if isinstance(new, Mapping) and isinstance(new.get("current_total"), int):
            new_total = int(new["current_total"])

    relation_supported = bool(
        isinstance(relation, Mapping) and relation.get("same_broad_operator_family_lead")
    )
    prior_collapse = PRIOR_VERIFIED_LEGACY_TREND["monthly_2026"]["2026-01"] >= 400 and PRIOR_VERIFIED_LEGACY_TREND["monthly_2026"]["2026-03"] <= 25

    if relation_supported and prior_collapse and old_total is not None and new_total is not None:
        if new_total >= max(25, old_total * 2):
            state = "SUPPORTED_ASN_ROLE_SHIFT_OR_MIGRATION_LEAD"
            confidence = 0.78
            statement = (
                "A newer Phoenix/RTO ASN carries materially more current indexed exposure while "
                "the legacy KOMTEL ASN remains routed but externally sparse. This supports a broad "
                "ASN role shift, service migration or infrastructure split."
            )
        elif new_total > 0:
            state = "UNRESOLVED_DUAL_ASN_RESTRUCTURING"
            confidence = 0.62
            statement = (
                "Both related ASNs remain observable. The evidence supports restructuring or a role "
                "split but does not establish the direction or extent of service migration."
            )
        else:
            state = "UNRESOLVED_RIPE_RELATION_ONLY"
            confidence = 0.45
            statement = (
                "The related ASN structure is verified, but current Shodan exposure does not support "
                "a service-migration inference."
            )
    elif relation_supported:
        state = "UNRESOLVED_RIPE_RELATION_ONLY"
        confidence = 0.50
        statement = (
            "RIPE metadata supports a broad legacy/new operator relationship, but current passive "
            "exposure data is incomplete."
        )
    else:
        state = "INSUFFICIENT_RELATIONSHIP_EVIDENCE"
        confidence = 0.30
        statement = "Available metadata does not establish a reliable relationship between the ASNs."

    ratio = None
    if old_total is not None and new_total is not None:
        ratio = round((new_total + 1) / (old_total + 1), 3)
    return {
        "state": state,
        "confidence": confidence,
        "statement": statement,
        "current_total_legacy": old_total,
        "current_total_phoenix": new_total,
        "phoenix_to_legacy_current_ratio": ratio,
        "alternative_explanations": [
            "different service roles rather than migration",
            "Shodan crawl/indexing coverage differences",
            "NAT/firewall or exposure-policy differences",
            "parallel mobile and fixed-network infrastructure",
            "reorganization without physical infrastructure movement",
        ],
        "does_not_establish": [
            "people or equipment presence in a specific sector",
            "military use of a specific device or service",
            "exact network nodes or physical locations",
            "current surveillance or detection coverage",
        ],
    }


def run(out_path: str | Path) -> None:
    output: dict[str, Any] = {
        "schema_version": SCHEMA,
        "generated_at": utc_now(),
        "scope": (
            "Aggregate comparison of legacy KOMTEL and Phoenix/RTO ASNs. No prefixes, IPs, hosts, "
            "banners, vulnerabilities, exact locations or target-level output are retained."
        ),
        "asns": ASNS,
        "prior_verified_legacy_trend": PRIOR_VERIFIED_LEGACY_TREND,
        "ripe": {},
        "shodan": {},
        "provider_receipts": {},
        "errors": [],
        "relationship": {},
        "transition_assessment": {},
        "result_sha256": "",
    }

    for role, asn in ASNS.items():
        role_data: dict[str, Any] = {}
        try:
            whois, receipt = get_json(
                "https://stat.ripe.net/data/whois/data.json",
                params={"resource": asn},
                timeout=45,
            )
            role_data["whois"] = extract_ripe_fields(whois)
            output["provider_receipts"][f"ripe_whois_{role}"] = receipt
        except Exception as exc:
            output["errors"].append(
                {"source": f"ripe_whois_{role}", "error_type": type(exc).__name__, "message": str(exc)}
            )
        try:
            prefixes, receipt = get_json(
                "https://stat.ripe.net/data/announced-prefixes/data.json",
                params={"resource": asn},
                timeout=45,
            )
            raw_prefixes = prefixes.get("data", {}).get("prefixes", []) if isinstance(prefixes, Mapping) else []
            role_data["announced_prefix_count"] = len(raw_prefixes) if isinstance(raw_prefixes, list) else 0
            role_data["routed"] = bool(role_data["announced_prefix_count"])
            output["provider_receipts"][f"ripe_prefixes_{role}"] = receipt
        except Exception as exc:
            output["errors"].append(
                {"source": f"ripe_prefixes_{role}", "error_type": type(exc).__name__, "message": str(exc)}
            )
        output["ripe"][role] = role_data
        atomic_write(out_path, output)

    output["relationship"] = related_operator(
        output["ripe"].get("legacy", {}), output["ripe"].get("phoenix", {})
    )
    atomic_write(out_path, output)

    key = os.environ.get("SHODAN_API_KEY", "").strip()
    if key:
        for role, asn in ASNS.items():
            try:
                counts, receipt = shodan_count(asn, key)
                output["shodan"][role] = counts
                output["provider_receipts"][f"shodan_count_{role}"] = receipt
            except Exception as exc:
                output["errors"].append(
                    {"source": f"shodan_count_{role}", "error_type": type(exc).__name__, "message": str(exc)}
                )
            atomic_write(out_path, output)
            time.sleep(1.0)
        try:
            trend, receipt = shodan_trend(ASNS["phoenix"], key)
            output["shodan"]["phoenix_trend"] = trend
            output["provider_receipts"]["shodan_trend_phoenix"] = receipt
        except Exception as exc:
            output["errors"].append(
                {"source": "shodan_trend_phoenix", "error_type": type(exc).__name__, "message": str(exc)}
            )
    else:
        output["errors"].append(
            {"source": "shodan", "error_type": "NO_SECRET", "message": "SHODAN_API_KEY unavailable"}
        )

    output["transition_assessment"] = score_transition(output)
    output["next_gap"] = (
        "If the role-shift lead survives, correlate only at broad level with official reorganization, "
        "sanctions/entity, procurement/integrator, RF-provider and VHR evidence. Do not enumerate hosts."
    )
    material = dict(output)
    material["result_sha256"] = ""
    output["result_sha256"] = digest(material)
    atomic_write(out_path, output)
    print(
        json.dumps(
            {
                "relationship": output["relationship"],
                "transition_assessment": output["transition_assessment"],
                "ripe_summary": {
                    role: {
                        "announced_prefix_count": data.get("announced_prefix_count"),
                        "routed": data.get("routed"),
                        "fields": data.get("whois", {}).get("fields", {}),
                    }
                    for role, data in output["ripe"].items()
                },
                "shodan": output["shodan"],
                "errors": output["errors"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="AI-39 aggregate ASN transition discriminator")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    run(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
