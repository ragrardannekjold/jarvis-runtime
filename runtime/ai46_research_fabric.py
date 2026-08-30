from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import math
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

SCHEMA_VERSION = "AI46_RESEARCH_FABRIC_V0_1"
MISSION_SCHEMA = "AI46_MISSION_V0_1"
ENVELOPE_SCHEMA = "AI46_EVIDENCE_ENVELOPE_V0_1"
AGGREGATE_SCHEMA = "AI46_AGGREGATE_V0_1"

BROAD_AOI = [37.65, 48.45, 38.25, 48.90]
FORBIDDEN_OUTPUT_KEYS = {
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


class ProviderBackpressure(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: Any) -> str:
    text = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def atomic_write_json(path: str | Path, value: Mapping[str, Any]) -> None:
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


def stable_mission_id(objective: str, scope: str) -> str:
    if not objective.strip() or not scope.strip():
        raise ValueError("objective and scope are required")
    material = {"objective": re.sub(r"\s+", " ", objective.casefold()).strip(), "scope": scope}
    return f"AI46-{sha256(material)[:16].upper()}"


def _document_digest(document: Mapping[str, Any], field: str) -> str:
    material = copy.deepcopy(dict(document))
    material[field] = ""
    return sha256(material)


def seal_document(document: dict[str, Any], field: str) -> dict[str, Any]:
    document[field] = ""
    document[field] = _document_digest(document, field)
    return document


def validate_sealed(document: Mapping[str, Any], field: str) -> None:
    recorded = document.get(field)
    if not isinstance(recorded, str) or len(recorded) != 64:
        raise ValueError(f"missing {field}")
    if recorded != _document_digest(document, field):
        raise ValueError(f"{field} mismatch")


def safe_payload(value: Any) -> Any:
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, child in value.items():
            normalized = str(key).strip().casefold()
            if normalized in FORBIDDEN_OUTPUT_KEYS:
                continue
            out[str(key)] = safe_payload(child)
        return out
    if isinstance(value, list):
        return [safe_payload(item) for item in value]
    if isinstance(value, tuple):
        return [safe_payload(item) for item in value]
    return value


def compile_mission() -> dict[str, Any]:
    objective = (
        "Test whether three independent read-only evidence workers can update the AI-39 "
        "broad-area evidence ledger without blocking the interactive GPT control surface."
    )
    safe_scope = (
        "Chasiv Yar–Bakhmut–Soledar with Horlivka–Donetsk extension; broad 4x4 sectors "
        "and aggregate entity/network classes only."
    )
    mission_id = stable_mission_id(objective, safe_scope)
    mission: dict[str, Any] = {
        "schema_version": MISSION_SCHEMA,
        "fabric_version": SCHEMA_VERSION,
        "mission_id": mission_id,
        "created_at": utc_now(),
        "objective": objective,
        "safe_scope": safe_scope,
        "safety": {
            "passive_only": True,
            "no_active_scanning": True,
            "no_exact_positions": True,
            "no_routes": True,
            "no_targeting": True,
            "no_new_spend": True,
        },
        "candidate_ledger": {
            "D4": {
                "state": "WEAK",
                "organized_presence_confidence": 0.32,
                "terrain_artifact_weight": 0.45,
                "agriculture_explanation_weight": 0.70,
                "note": (
                    "Repeated broad SAR discrepancy is real; agriculture remains favored. "
                    "Terrain artifact has not yet been robustly calibrated."
                ),
            },
            "AS202279_RESTRUCTURING": {
                "state": "SUPPORTED",
                "confidence": 0.70,
                "note": "Low external exposure while the ASN remains routed suggests restructuring.",
            },
        },
        "workers": [
            {"id": "cybint", "source_class": "PASSIVE_CYBINT"},
            {"id": "terrain", "source_class": "EO_TERRAIN"},
            {"id": "entity", "source_class": "OFFICIAL_ENTITY_DOCUMENT"},
        ],
        "entity_terms": [
            "KOMTEL",
            "REPUBLICAN TELECOMMUNICATIONS OPERATOR",
            "AS202279",
            "ORG-SUEO4-RIPE",
        ],
        "mission_sha256": "",
    }
    return seal_document(mission, "mission_sha256")


def load_mission(path: str | Path) -> dict[str, Any]:
    mission = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(mission, dict) or mission.get("schema_version") != MISSION_SCHEMA:
        raise ValueError("invalid mission")
    validate_sealed(mission, "mission_sha256")
    return mission


def _new_envelope(mission: Mapping[str, Any], worker_id: str, source_class: str) -> dict[str, Any]:
    return {
        "schema_version": ENVELOPE_SCHEMA,
        "fabric_version": SCHEMA_VERSION,
        "mission_id": mission["mission_id"],
        "worker_id": worker_id,
        "source_class": source_class,
        "started_at": utc_now(),
        "completed_at": None,
        "status": "STARTED",
        "provider_status": {},
        "observations": {},
        "claims": [],
        "evidence_refs": [],
        "errors": [],
        "external_side_effects": False,
        "safe_output": True,
        "envelope_sha256": "",
    }


def write_envelope(path: str | Path, envelope: dict[str, Any]) -> None:
    envelope["completed_at"] = utc_now()
    cleaned = safe_payload(envelope)
    if not isinstance(cleaned, dict):
        raise ValueError("envelope must remain an object")
    seal_document(cleaned, "envelope_sha256")
    atomic_write_json(path, cleaned)


def load_envelope(path: str | Path) -> dict[str, Any]:
    envelope = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(envelope, dict) or envelope.get("schema_version") != ENVELOPE_SCHEMA:
        raise ValueError("invalid envelope")
    validate_sealed(envelope, "envelope_sha256")
    return envelope


def _get_response(
    url: str,
    *,
    params: Mapping[str, Any] | None = None,
    timeout: float = 45,
    attempts: int = 2,
):
    import requests

    last_status: int | None = None
    for attempt in range(attempts):
        response = requests.get(url, params=params, timeout=timeout)
        last_status = response.status_code
        if response.status_code != 429:
            response.raise_for_status()
            return response
        retry_after = response.headers.get("Retry-After", "2")
        try:
            wait = min(max(float(retry_after), 0.5), 20.0)
        except ValueError:
            wait = 2.0
        if attempt + 1 < attempts:
            time.sleep(wait)
    raise ProviderBackpressure(f"HTTP 429 after {attempts} attempts ({last_status})")


def _limited_facets(raw: Any, limit: int = 10) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[:limit]:
        if not isinstance(item, Mapping):
            continue
        value = item.get("value")
        count = item.get("count")
        if isinstance(value, (str, int, float)) and isinstance(count, int):
            out.append({"value": str(value), "count": count})
    return out


def run_cybint(mission: Mapping[str, Any], out_path: str | Path) -> None:
    envelope = _new_envelope(mission, "cybint", "PASSIVE_CYBINT")
    key = os.environ.get("SHODAN_API_KEY", "").strip()
    try:
        announced = _get_response(
            "https://stat.ripe.net/data/announced-prefixes/data.json",
            params={"resource": "AS202279"},
        ).json()
        prefixes = (
            announced.get("data", {}).get("prefixes", [])
            if isinstance(announced, Mapping)
            else []
        )
        prefix_count = len(prefixes) if isinstance(prefixes, list) else 0
        envelope["observations"]["ripe"] = {
            "asn": "AS202279",
            "announced_prefix_count": prefix_count,
            "routed": prefix_count > 0,
        }
        envelope["provider_status"]["ripe"] = "OK"
        envelope["status"] = "PARTIAL"
        write_envelope(out_path, envelope)

        shodan_total: int | None = None
        if key:
            try:
                response = _get_response(
                    "https://api.shodan.io/shodan/host/count",
                    params={
                        "key": key,
                        "query": "asn:AS202279",
                        "facets": "org:10,port:20,product:10",
                    },
                    timeout=60,
                )
                body = response.json()
                shodan_total = body.get("total") if isinstance(body, Mapping) else None
                facets = body.get("facets", {}) if isinstance(body, Mapping) else {}
                envelope["observations"]["shodan"] = {
                    "current_total": shodan_total,
                    "org_facets": _limited_facets(
                        facets.get("org", []) if isinstance(facets, Mapping) else []
                    ),
                    "port_facets": _limited_facets(
                        facets.get("port", []) if isinstance(facets, Mapping) else [], 20
                    ),
                    "product_facets": _limited_facets(
                        facets.get("product", []) if isinstance(facets, Mapping) else []
                    ),
                    "query_count": 1,
                }
                envelope["provider_status"]["shodan"] = "OK"
            except ProviderBackpressure as exc:
                envelope["provider_status"]["shodan"] = "BACKPRESSURE"
                envelope["errors"].append(
                    {"provider": "shodan", "error_type": type(exc).__name__, "message": str(exc)}
                )
            except Exception as exc:
                envelope["provider_status"]["shodan"] = "DEGRADED"
                envelope["errors"].append(
                    {"provider": "shodan", "error_type": type(exc).__name__, "message": str(exc)}
                )
        else:
            envelope["provider_status"]["shodan"] = "NO_SECRET"

        if prefix_count > 0 and isinstance(shodan_total, int) and shodan_total <= 25:
            state = "SUPPORTED"
            confidence = 0.75
            delta = 0.05
            statement = (
                "The ASN remains routed while indexed external exposure is low, supporting "
                "a network exposure-policy or infrastructure-restructuring explanation."
            )
        elif prefix_count > 0:
            state = "UNRESOLVED"
            confidence = 0.52
            delta = 0.0
            statement = (
                "The ASN remains routed, but current Shodan evidence is absent or insufficient "
                "to re-score the restructuring hypothesis."
            )
        else:
            state = "INSUFFICIENT_DATA"
            confidence = 0.25
            delta = 0.0
            statement = "Routing readback did not establish a current announced footprint."

        envelope["claims"].append(
            {
                "claim_id": "AI39-CYBINT-AS202279-RESTRUCTURING",
                "candidate_id": "AS202279_RESTRUCTURING",
                "state": state,
                "confidence": confidence,
                "confidence_delta": delta,
                "statement": statement,
                "alternative_explanations": [
                    "Shodan crawl/indexing changes",
                    "NAT or re-addressing",
                    "service centralization",
                    "firewall/exposure policy change",
                ],
            }
        )
        envelope["evidence_refs"] = [
            "RIPEstat announced-prefixes AS202279",
            "Shodan host/count aggregate AS202279" if key else "Shodan secret unavailable",
        ]
        envelope["status"] = "VERIFIED_PARTIAL" if envelope["errors"] else "VERIFIED_DONE"
    except Exception as exc:
        envelope["status"] = "DEGRADED"
        envelope["errors"].append(
            {"provider": "worker", "error_type": type(exc).__name__, "message": str(exc)}
        )
    write_envelope(out_path, envelope)


def percentile_ranks(values: Iterable[float]) -> list[float]:
    vals = [float(value) for value in values]
    if not vals:
        return []
    if len(vals) == 1:
        return [0.5]
    ranks: list[float] = []
    denominator = len(vals) - 1
    for value in vals:
        less = sum(other < value for other in vals)
        equal = sum(other == value for other in vals)
        rank = (less + 0.5 * (equal - 1)) / denominator
        ranks.append(max(0.0, min(1.0, rank)))
    return ranks


def calibrate_sector_metrics(cells: list[dict[str, Any]]) -> list[dict[str, Any]]:
    metrics = [
        "elev_p05_p95_range_m",
        "slope_median_deg",
        "local_relief_p95_abs_m",
        "roughness_p95_m",
    ]
    valid = [cell for cell in cells if all(isinstance(cell.get(m), (int, float)) for m in metrics)]
    for metric in metrics:
        ranks = percentile_ranks([float(cell[metric]) for cell in valid])
        for cell, rank in zip(valid, ranks):
            cell.setdefault("relative_percentiles", {})[metric] = round(rank, 4)
    for cell in valid:
        percentiles = cell["relative_percentiles"]
        cell["terrain_confound_percentile"] = round(
            sum(float(percentiles[m]) for m in metrics) / len(metrics), 4
        )
    return cells


def run_terrain(mission: Mapping[str, Any], out_path: str | Path) -> None:
    envelope = _new_envelope(mission, "terrain", "EO_TERRAIN")
    try:
        import numpy as np
        import rasterio
        from planetary_computer import sign_inplace
        from pystac_client import Client
        from rasterio.enums import Resampling
        from rasterio.transform import from_bounds
        from rasterio.warp import reproject
        from scipy.ndimage import gaussian_filter, uniform_filter

        width, height = 1200, 900
        transform = from_bounds(*BROAD_AOI, width, height)
        dem = np.full((height, width), np.nan, np.float32)
        item_ids: list[str] = []
        catalog = Client.open("https://planetarycomputer.microsoft.com/api/stac/v1")
        items = list(catalog.search(collections=["cop-dem-glo-30"], bbox=BROAD_AOI).items())
        for item in items[:20]:
            sign_inplace(item)
            asset = item.assets.get("data") or next(
                (candidate for candidate in item.assets.values() if "tif" in candidate.href.lower()),
                None,
            )
            if asset is None:
                continue
            tile = np.full((height, width), np.nan, np.float32)
            try:
                with rasterio.open(asset.href) as dataset:
                    reproject(
                        source=rasterio.band(dataset, 1),
                        destination=tile,
                        src_transform=dataset.transform,
                        src_crs=dataset.crs,
                        src_nodata=dataset.nodata,
                        dst_transform=transform,
                        dst_crs="EPSG:4326",
                        dst_nodata=np.nan,
                        resampling=Resampling.bilinear,
                    )
                mask = np.isfinite(tile)
                dem[mask] = tile[mask]
                item_ids.append(item.id)
            except Exception as exc:
                envelope["errors"].append(
                    {"provider": "cop-dem", "error_type": type(exc).__name__, "message": str(exc)}
                )

        valid = np.isfinite(dem)
        if float(valid.mean()) < 0.50:
            raise RuntimeError("insufficient Copernicus DEM coverage")

        fill = float(np.nanmedian(dem[valid]))
        surface = np.where(valid, dem, fill)
        latitude = (BROAD_AOI[1] + BROAD_AOI[3]) / 2
        dx = ((BROAD_AOI[2] - BROAD_AOI[0]) * 111320 * math.cos(math.radians(latitude))) / width
        dy = ((BROAD_AOI[3] - BROAD_AOI[1]) * 110540) / height
        grad_y, grad_x = np.gradient(surface, dy, dx)
        slope = np.degrees(np.arctan(np.hypot(grad_x, grad_y)))
        local_relief = surface - gaussian_filter(surface, sigma=3)
        roughness = np.sqrt(
            np.maximum(
                0,
                uniform_filter(surface * surface, size=7)
                - uniform_filter(surface, size=7) ** 2,
            )
        )

        cells: list[dict[str, Any]] = []
        for row in range(4):
            for col in range(4):
                ys = slice(row * height // 4, (row + 1) * height // 4)
                xs = slice(col * width // 4, (col + 1) * width // 4)
                mask = valid[ys, xs]
                record: dict[str, Any] = {
                    "sector": f"{'ABCD'[col]}{row + 1}",
                    "valid_percent": round(float(mask.mean() * 100), 1),
                }
                if int(mask.sum()) > 100:
                    def quantile(array: Any, percentile: float) -> float:
                        return float(np.nanpercentile(array[ys, xs][mask], percentile))

                    record.update(
                        {
                            "elev_p05_p95_range_m": round(
                                quantile(surface, 95) - quantile(surface, 5), 2
                            ),
                            "slope_median_deg": round(quantile(slope, 50), 3),
                            "local_relief_p95_abs_m": round(
                                float(
                                    np.nanpercentile(
                                        np.abs(local_relief[ys, xs][mask]), 95
                                    )
                                ),
                                3,
                            ),
                            "roughness_p95_m": round(quantile(roughness, 95), 3),
                        }
                    )
                cells.append(record)

        calibrate_sector_metrics(cells)
        d4 = next((cell for cell in cells if cell.get("sector") == "D4"), None)
        d4_score = (
            float(d4["terrain_confound_percentile"])
            if isinstance(d4, Mapping)
            and isinstance(d4.get("terrain_confound_percentile"), (int, float))
            else None
        )
        if d4_score is not None and d4_score <= 0.20:
            state = "SUPPORTED"
            confidence = 0.68
            alternative_delta = -0.15
            statement = (
                "D4 lies in the low-relief tail of the AOI across elevation range, slope, "
                "local relief and roughness; a broad terrain-induced SAR artifact is less plausible."
            )
        else:
            state = "UNRESOLVED"
            confidence = 0.45
            alternative_delta = 0.0
            statement = (
                "AOI-relative terrain metrics do not robustly weaken the terrain-artifact "
                "alternative for D4."
            )

        envelope["observations"]["terrain"] = {
            "source": "Copernicus DEM GLO-30 via Planetary Computer",
            "pixel_class": "approximately 30 m",
            "dem_item_ids": item_ids,
            "cells": cells,
            "d4_terrain_confound_percentile": d4_score,
        }
        envelope["claims"].append(
            {
                "claim_id": "AI39-D4-TERRAIN-CONFOUND",
                "candidate_id": "D4",
                "state": state,
                "confidence": confidence,
                "alternative_weight_delta": alternative_delta,
                "alternative": "terrain_artifact",
                "statement": statement,
                "interpretation_limit": (
                    "DEM derivatives are contextual falsifiers only and cannot resolve individual "
                    "trenches, equipment or people."
                ),
            }
        )
        envelope["evidence_refs"] = [
            f"Copernicus DEM item {item_id}" for item_id in item_ids
        ] or ["Copernicus DEM GLO-30"]
        envelope["provider_status"]["planetary_computer"] = "OK"
        envelope["status"] = "VERIFIED_PARTIAL" if envelope["errors"] else "VERIFIED_DONE"
    except Exception as exc:
        envelope["status"] = "DEGRADED"
        envelope["errors"].append(
            {"provider": "terrain_worker", "error_type": type(exc).__name__, "message": str(exc)}
        )
    write_envelope(out_path, envelope)


def _first_nonempty(row: Mapping[str, str], candidates: Iterable[str]) -> str | None:
    for candidate in candidates:
        value = row.get(candidate)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def run_entity(mission: Mapping[str, Any], out_path: str | Path) -> None:
    envelope = _new_envelope(mission, "entity", "OFFICIAL_ENTITY_DOCUMENT")
    url = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv"
    try:
        response = _get_response(url, timeout=90)
        content = response.content
        text = content.decode("utf-8-sig", errors="replace")
        rows = list(csv.DictReader(text.splitlines()))
        terms = [
            str(term).casefold()
            for term in mission.get("entity_terms", [])
            if isinstance(term, str) and term.strip()
        ]
        matches: list[dict[str, Any]] = []
        for row in rows:
            haystack = " ".join(str(value) for value in row.values()).casefold()
            matched = [term for term in terms if term in haystack]
            if not matched:
                continue
            matches.append(
                {
                    "unique_id": _first_nonempty(row, ["Unique ID", "UniqueID", "UK Sanctions List Ref"]),
                    "name": _first_nonempty(
                        row,
                        [
                            "Name 1",
                            "Name",
                            "Primary Name",
                            "Individual, Entity, Ship",
                        ],
                    ),
                    "designation_type": _first_nonempty(
                        row, ["Designation Type", "Type"]
                    ),
                    "regime": _first_nonempty(row, ["Regime Name", "Regime"]),
                    "matched_terms": matched,
                }
            )
        matches = matches[:20]
        if matches:
            state = "SUPPORTED"
            confidence = 0.85
            statement = "The official UK Sanctions List contains a direct textual match."
        else:
            state = "UNRESOLVED"
            confidence = 0.25
            statement = (
                "No direct textual match was found in the current UK Sanctions List. "
                "This is weak negative evidence and does not establish legitimacy, ownership or control."
            )
        envelope["observations"]["uk_sanctions"] = {
            "source": "FCDO UK Sanctions List CSV",
            "retrieved_at": utc_now(),
            "document_sha256": hashlib.sha256(content).hexdigest(),
            "row_count": len(rows),
            "match_count": len(matches),
            "matches": matches,
        }
        envelope["claims"].append(
            {
                "claim_id": "AI39-ENTITY-UK-SANCTIONS-DIRECT-MATCH",
                "candidate_id": "AS202279_RESTRUCTURING",
                "state": state,
                "confidence": confidence,
                "confidence_delta": 0.0,
                "statement": statement,
                "interpretation_limit": (
                    "List absence is not proof of non-sanctioned ownership/control and does not "
                    "replace broader counterparty, procurement or sanctions-ownership analysis."
                ),
            }
        )
        envelope["evidence_refs"] = [
            "FCDO UK Sanctions List CSV",
            f"document_sha256:{hashlib.sha256(content).hexdigest()}",
        ]
        envelope["provider_status"]["fcdo"] = "OK"
        envelope["status"] = "VERIFIED_DONE"
    except ProviderBackpressure as exc:
        envelope["status"] = "DEGRADED"
        envelope["provider_status"]["fcdo"] = "BACKPRESSURE"
        envelope["errors"].append(
            {"provider": "fcdo", "error_type": type(exc).__name__, "message": str(exc)}
        )
    except Exception as exc:
        envelope["status"] = "DEGRADED"
        envelope["provider_status"]["fcdo"] = "DEGRADED"
        envelope["errors"].append(
            {"provider": "fcdo", "error_type": type(exc).__name__, "message": str(exc)}
        )
    write_envelope(out_path, envelope)


def aggregate_results(
    mission: Mapping[str, Any], envelopes: Iterable[Mapping[str, Any]]
) -> dict[str, Any]:
    ledger = copy.deepcopy(mission.get("candidate_ledger", {}))
    if not isinstance(ledger, dict):
        raise ValueError("candidate ledger must be an object")

    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    evidence_impacts: list[dict[str, Any]] = []
    decision_change_count = 0

    for envelope in envelopes:
        try:
            if envelope.get("mission_id") != mission.get("mission_id"):
                raise ValueError("mission mismatch")
            if envelope.get("schema_version") != ENVELOPE_SCHEMA:
                raise ValueError("schema mismatch")
            validate_sealed(envelope, "envelope_sha256")
            accepted.append(copy.deepcopy(dict(envelope)))
        except Exception as exc:
            rejected.append({"error_type": type(exc).__name__, "message": str(exc)})
            continue

        claims = envelope.get("claims", [])
        if not isinstance(claims, list):
            continue
        for claim in claims:
            if not isinstance(claim, Mapping):
                continue
            candidate_id = claim.get("candidate_id")
            if not isinstance(candidate_id, str) or candidate_id not in ledger:
                continue
            impact = {
                "worker_id": envelope.get("worker_id"),
                "claim_id": claim.get("claim_id"),
                "candidate_id": candidate_id,
                "state": claim.get("state"),
                "confidence": claim.get("confidence"),
                "statement": claim.get("statement"),
            }
            if candidate_id == "D4" and claim.get("alternative") == "terrain_artifact":
                delta = claim.get("alternative_weight_delta")
                if isinstance(delta, (int, float)) and delta:
                    prior = float(ledger["D4"].get("terrain_artifact_weight", 0.45))
                    updated = max(0.0, min(1.0, prior + float(delta)))
                    ledger["D4"]["terrain_artifact_weight"] = round(updated, 3)
                    ledger["D4"]["terrain_context_state"] = claim.get("state")
                    impact["prior_alternative_weight"] = prior
                    impact["updated_alternative_weight"] = updated
                    decision_change_count += 1
            elif candidate_id == "AS202279_RESTRUCTURING":
                delta = claim.get("confidence_delta")
                if isinstance(delta, (int, float)) and delta:
                    prior = float(ledger[candidate_id].get("confidence", 0.70))
                    updated = max(0.0, min(1.0, prior + float(delta)))
                    ledger[candidate_id]["confidence"] = round(updated, 3)
                    impact["prior_confidence"] = prior
                    impact["updated_confidence"] = updated
                    decision_change_count += 1
            evidence_impacts.append(impact)

    valid_count = len(accepted)
    if valid_count == 3:
        status = "VERIFIED_DONE"
    elif valid_count >= 1:
        status = "PARTIAL_SUCCESS"
    else:
        status = "FAILED"

    d4 = ledger.get("D4", {})
    terrain_weight = d4.get("terrain_artifact_weight")
    if isinstance(terrain_weight, (int, float)) and terrain_weight < 0.45:
        material_delta = (
            "D4: the broad terrain-artifact alternative is weakened by AOI-relative DEM metrics. "
            "The organized-presence interpretation is not promoted; agriculture remains favored."
        )
        chat_readback = (
            "Нове: для D4 рельєфний SAR-артефакт став менш імовірним. "
            "Це не доводить людей або техніку; аграрне пояснення досі сильніше. "
            "Наступний найцінніший крок — незалежний RF-сигнал або non-crop/VHR morphology."
        )
    else:
        material_delta = (
            "No worker produced a decision-changing D4 update; preserve the prior weak state."
        )
        chat_readback = (
            "Нової доказової зміни для D4 немає. Стан лишається WEAK; "
            "потрібен незалежний RF або VHR/non-crop сигнал."
        )

    aggregate: dict[str, Any] = {
        "schema_version": AGGREGATE_SCHEMA,
        "fabric_version": SCHEMA_VERSION,
        "mission_id": mission["mission_id"],
        "generated_at": utc_now(),
        "status": status,
        "worker_count_expected": 3,
        "worker_count_accepted": valid_count,
        "worker_count_rejected": len(rejected),
        "worker_statuses": {
            str(item.get("worker_id")): item.get("status") for item in accepted
        },
        "candidate_ledger": ledger,
        "evidence_impacts": evidence_impacts,
        "rejected_worker_results": rejected,
        "decision_change_count": decision_change_count,
        "material_delta": material_delta,
        "next_gap": (
            "Obtain an independent broad RF observation or high-resolution/non-crop morphology "
            "that can discriminate organized activity from agriculture for D4."
        ),
        "chat_readback": chat_readback,
        "external_side_effects": False,
        "aggregate_sha256": "",
    }
    return seal_document(aggregate, "aggregate_sha256")


def load_envelopes(root: str | Path) -> list[dict[str, Any]]:
    paths = sorted(Path(root).rglob("*.json"))
    envelopes: list[dict[str, Any]] = []
    for path in paths:
        try:
            candidate = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(candidate, dict) and candidate.get("schema_version") == ENVELOPE_SCHEMA:
                envelopes.append(candidate)
        except Exception:
            continue
    return envelopes


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI-46 bounded responsive research fabric")
    subparsers = parser.add_subparsers(dest="command", required=True)

    compile_parser = subparsers.add_parser("compile")
    compile_parser.add_argument("--out", required=True)

    worker_parser = subparsers.add_parser("worker")
    worker_parser.add_argument("--name", choices=["cybint", "terrain", "entity"], required=True)
    worker_parser.add_argument("--mission", required=True)
    worker_parser.add_argument("--out", required=True)

    aggregate_parser = subparsers.add_parser("aggregate")
    aggregate_parser.add_argument("--mission", required=True)
    aggregate_parser.add_argument("--workers-root", required=True)
    aggregate_parser.add_argument("--out", required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "compile":
        atomic_write_json(args.out, compile_mission())
        return 0
    if args.command == "worker":
        mission = load_mission(args.mission)
        if args.name == "cybint":
            run_cybint(mission, args.out)
        elif args.name == "terrain":
            run_terrain(mission, args.out)
        else:
            run_entity(mission, args.out)
        return 0
    if args.command == "aggregate":
        mission = load_mission(args.mission)
        aggregate = aggregate_results(mission, load_envelopes(args.workers_root))
        atomic_write_json(args.out, aggregate)
        print(json.dumps(
            {
                "status": aggregate["status"],
                "decision_change_count": aggregate["decision_change_count"],
                "material_delta": aggregate["material_delta"],
                "chat_readback": aggregate["chat_readback"],
            },
            ensure_ascii=False,
            indent=2,
        ))
        return 0
    raise AssertionError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
