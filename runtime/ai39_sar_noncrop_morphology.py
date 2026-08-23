from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

BBOX = [37.65, 48.45, 38.25, 48.90]
WIDTH, HEIGHT = 960, 720
SCHEMA_YEAR = "AI39_SAR_NONCROP_MORPHOLOGY_YEAR_V0_1"
SCHEMA_COMPARE = "AI39_SAR_NONCROP_MORPHOLOGY_COMPARE_V0_1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: Any) -> str:
    text = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def seal(document: dict[str, Any], field: str) -> dict[str, Any]:
    document[field] = ""
    document[field] = sha256(document)
    return document


def validate_seal(document: Mapping[str, Any], field: str) -> None:
    recorded = document.get(field)
    if not isinstance(recorded, str) or len(recorded) != 64:
        raise ValueError(f"missing {field}")
    material = dict(document)
    material[field] = ""
    if sha256(material) != recorded:
        raise ValueError(f"{field} mismatch")


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


def sector_name(row: int, col: int) -> str:
    return f"{'ABCD'[col]}{row + 1}"


def percentile_ranks(values: Iterable[float]) -> list[float]:
    vals = [float(value) for value in values]
    if not vals:
        return []
    if len(vals) == 1:
        return [0.5]
    denominator = len(vals) - 1
    result: list[float] = []
    for value in vals:
        less = sum(other < value for other in vals)
        equal = sum(other == value for other in vals)
        result.append(max(0.0, min(1.0, (less + 0.5 * (equal - 1)) / denominator)))
    return result


def component_metrics(mask: Any, *, minimum_pixels: int = 4) -> list[dict[str, float]]:
    import numpy as np
    from scipy.ndimage import binary_erosion, label

    structure = np.ones((3, 3), dtype=np.uint8)
    labels, count = label(mask.astype(bool), structure=structure)
    output: list[dict[str, float]] = []
    for component_id in range(1, count + 1):
        component = labels == component_id
        area = int(component.sum())
        if area < minimum_pixels:
            continue
        yy, xx = np.nonzero(component)
        if len(xx) < 2:
            elongation = 1.0
        else:
            covariance = np.cov(np.vstack([xx, yy]))
            eigenvalues = np.linalg.eigvalsh(covariance)
            minor = max(float(eigenvalues[0]), 1e-6)
            major = max(float(eigenvalues[-1]), minor)
            elongation = math.sqrt(major / minor)
        boundary = component & ~binary_erosion(component, structure=structure, border_value=0)
        perimeter = max(int(boundary.sum()), 1)
        compactness = min(1.0, 4 * math.pi * area / (perimeter * perimeter))
        bbox_area = max((int(xx.max()) - int(xx.min()) + 1) * (int(yy.max()) - int(yy.min()) + 1), 1)
        output.append(
            {
                "area_pixels": float(area),
                "elongation": round(float(elongation), 3),
                "compactness": round(float(compactness), 3),
                "bbox_occupancy": round(float(area / bbox_area), 3),
            }
        )
    output.sort(key=lambda item: (item["area_pixels"], item["elongation"]), reverse=True)
    return output


def compare_sector(current: Mapping[str, Any], historical: Mapping[str, Any]) -> dict[str, Any]:
    c_pairs = int(current.get("measured_pairs", 0))
    h_pairs = int(historical.get("measured_pairs", 0))
    c_repeat = float(current.get("structural_repeat_percent", 0.0))
    h_repeat = float(historical.get("structural_repeat_percent", 0.0))
    c_enrichment = float(current.get("structural_vs_crop_enrichment", 0.0))
    c_components = int(current.get("robust_component_count", 0))
    c_linear = int(current.get("elongated_component_count", 0))

    if min(c_pairs, h_pairs) < 2:
        state = "INSUFFICIENT_DATA"
    elif (
        c_repeat >= max(0.10, 2.0 * h_repeat + 0.05)
        and c_enrichment >= 1.5
        and c_components >= 1
    ):
        state = "UNRESOLVED_NONCROP_REPEAT_LEAD"
    elif c_repeat <= h_repeat + 0.05 or c_components == 0:
        state = "NO_NONCROP_ESCALATION"
    else:
        state = "WEAK_NONCROP_DIFFERENCE"

    return {
        "sector": current.get("sector"),
        "state": state,
        "measured_pairs_2026": c_pairs,
        "measured_pairs_2025": h_pairs,
        "structural_repeat_percent_2026": round(c_repeat, 4),
        "structural_repeat_percent_2025": round(h_repeat, 4),
        "structural_repeat_delta_pp": round(c_repeat - h_repeat, 4),
        "structural_repeat_ratio": round((c_repeat + 0.01) / (h_repeat + 0.01), 3),
        "structural_vs_crop_enrichment_2026": round(c_enrichment, 3),
        "robust_component_count_2026": c_components,
        "elongated_component_count_2026": c_linear,
        "max_component_pixels_2026": current.get("max_component_pixels", 0),
        "max_component_elongation_2026": current.get("max_component_elongation", 0.0),
        "interpretation": (
            "Aggregate connected-component morphology at approximately 40–60 m working scale; "
            "not object identification, trench detection, equipment detection or causal attribution."
        ),
    }


def run_year(year: int, out_path: str | Path, max_pairs: int = 4) -> None:
    import numpy as np
    import rasterio
    from planetary_computer import sign_inplace
    from pystac_client import Client
    from rasterio.enums import Resampling
    from rasterio.transform import from_bounds
    from rasterio.vrt import WarpedVRT
    from scipy.ndimage import uniform_filter

    if year not in {2025, 2026}:
        raise ValueError("year must be 2025 or 2026")

    transform = from_bounds(*BBOX, WIDTH, HEIGHT)
    catalog = Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1", modifier=sign_inplace
    )

    # Historical land cover is a prior/falsifier, never current truth.
    lc_items = list(
        catalog.search(
            collections=["io-lulc-9-class"], bbox=BBOX, datetime="2023-01-01/2023-12-31"
        ).items()
    )
    landcover = np.zeros((HEIGHT, WIDTH), np.uint8)
    lc_ids: list[str] = []
    for item in lc_items:
        asset = item.assets.get("data") or item.assets.get("map") or next(
            (candidate for candidate in item.assets.values() if "tif" in candidate.href.lower()),
            None,
        )
        if asset is None:
            continue
        try:
            with rasterio.open(asset.href) as dataset:
                with WarpedVRT(
                    dataset,
                    crs="EPSG:4326",
                    transform=transform,
                    width=WIDTH,
                    height=HEIGHT,
                    resampling=Resampling.nearest,
                    nodata=0,
                ) as vrt:
                    tile = vrt.read(1).astype(np.uint8)
            valid = tile > 0
            landcover[valid] = tile[valid]
            lc_ids.append(item.id)
        except Exception:
            continue
    if float((landcover > 0).mean()) < 0.50:
        raise RuntimeError("insufficient land-cover prior coverage")

    start = f"{year}-07-24"
    end = f"{year}-08-23"
    items = list(
        catalog.search(
            collections=["sentinel-1-rtc"], bbox=BBOX, datetime=f"{start}/{end}", max_items=400
        ).items()
    )
    groups: dict[tuple[str, int, str], dict[str, list[Any]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for item in items:
        properties = item.properties
        date = item.datetime.date().isoformat() if item.datetime else ""
        platform = str(properties.get("platform") or "").lower()
        relative_orbit = properties.get("sat:relative_orbit")
        orbit_state = str(properties.get("sat:orbit_state") or "")
        if (
            date
            and platform
            and relative_orbit is not None
            and "vv" in item.assets
            and "vh" in item.assets
        ):
            groups[(platform, int(relative_orbit), orbit_state)][date].append(item)

    candidates: list[tuple[str, str, tuple[str, int, str], list[Any], list[Any]]] = []
    for geometry, dates in groups.items():
        ordered = sorted(dates)
        latest_for_geometry = None
        for index, first in enumerate(ordered):
            for second in ordered[index + 1 :]:
                separation = (datetime.fromisoformat(second) - datetime.fromisoformat(first)).days
                if 10 <= separation <= 14:
                    candidate = (second, first, geometry, dates[first], dates[second])
                    if latest_for_geometry is None or (second, first) > (
                        latest_for_geometry[0],
                        latest_for_geometry[1],
                    ):
                        latest_for_geometry = candidate
        if latest_for_geometry is not None:
            candidates.append(latest_for_geometry)
    candidates.sort(reverse=True, key=lambda item: (item[0], item[1]))
    chosen = candidates[:max_pairs]

    def mosaic(members: list[Any], asset_key: str) -> tuple[Any, list[str]]:
        destination = np.full((HEIGHT, WIDTH), np.nan, np.float32)
        ids: list[str] = []
        for item in members:
            try:
                ids.append(item.id)
                with rasterio.open(item.assets[asset_key].href) as dataset:
                    with WarpedVRT(
                        dataset,
                        crs="EPSG:4326",
                        transform=transform,
                        width=WIDTH,
                        height=HEIGHT,
                        resampling=Resampling.bilinear,
                        nodata=np.nan,
                    ) as vrt:
                        tile = vrt.read(1).astype(np.float32)
                mask = np.isfinite(tile) & (tile != 0)
                overlap = mask & np.isfinite(destination)
                destination[overlap] = (destination[overlap] + tile[overlap]) / 2
                only = mask & ~np.isfinite(destination)
                destination[only] = tile[only]
            except Exception:
                continue
        return destination, sorted(set(ids))

    def to_db(array: Any, valid: Any) -> Any:
        median = float(np.nanmedian(array[valid]))
        return array.copy() if median < 0 else 10 * np.log10(np.maximum(array, 1e-12))

    crop = landcover == 5
    structural = np.isin(landcover, [7, 8, 11])
    valid_counts = np.zeros((HEIGHT, WIDTH), np.uint8)
    changed_counts = np.zeros((HEIGHT, WIDTH), np.uint8)
    pair_records: list[dict[str, Any]] = []

    for second, first, geometry, members_a, members_b in chosen:
        vv_a, ids_a = mosaic(members_a, "vv")
        vh_a, _ = mosaic(members_a, "vh")
        vv_b, ids_b = mosaic(members_b, "vv")
        vh_b, _ = mosaic(members_b, "vh")
        valid = (
            np.isfinite(vv_a)
            & np.isfinite(vh_a)
            & np.isfinite(vv_b)
            & np.isfinite(vh_b)
            & (vv_a != 0)
            & (vh_a != 0)
            & (vv_b != 0)
            & (vh_b != 0)
        )
        if float(valid.mean()) < 0.35:
            pair_records.append(
                {
                    "pair": [first, second],
                    "geometry": {
                        "platform": geometry[0],
                        "relative_orbit": geometry[1],
                        "orbit_state": geometry[2],
                    },
                    "status": "INSUFFICIENT_OVERLAP",
                    "valid_percent": round(float(valid.mean() * 100), 2),
                }
            )
            continue

        delta_vv = to_db(vv_b, valid) - to_db(vv_a, valid)
        delta_vh = to_db(vh_b, valid) - to_db(vh_a, valid)
        magnitude = np.sqrt((delta_vv * delta_vv + delta_vh * delta_vh) / 2)
        raw_change = valid & (magnitude >= 3.0)
        local_density = uniform_filter(raw_change.astype(np.float32), size=3, mode="nearest")
        change = raw_change & (local_density >= 0.33)
        valid_counts += valid.astype(np.uint8)
        changed_counts += change.astype(np.uint8)

        pair_records.append(
            {
                "pair": [first, second],
                "geometry": {
                    "platform": geometry[0],
                    "relative_orbit": geometry[1],
                    "orbit_state": geometry[2],
                },
                "status": "MEASURED",
                "valid_percent": round(float(valid.mean() * 100), 2),
                "product_identity_sha256": sha256({"a": ids_a, "b": ids_b}),
            }
        )

    measured_pairs = sum(record.get("status") == "MEASURED" for record in pair_records)
    repeat = changed_counts >= 2
    support = valid_counts >= 2
    sectors: list[dict[str, Any]] = []
    for row in range(4):
        for col in range(4):
            ys = slice(row * HEIGHT // 4, (row + 1) * HEIGHT // 4)
            xs = slice(col * WIDTH // 4, (col + 1) * WIDTH // 4)
            structural_support = support[ys, xs] & structural[ys, xs]
            crop_support = support[ys, xs] & crop[ys, xs]
            structural_repeat = repeat[ys, xs] & structural_support
            crop_repeat = repeat[ys, xs] & crop_support
            structural_percent = (
                float(structural_repeat.sum() / structural_support.sum() * 100)
                if int(structural_support.sum()) > 100
                else 0.0
            )
            crop_percent = (
                float(crop_repeat.sum() / crop_support.sum() * 100)
                if int(crop_support.sum()) > 100
                else 0.0
            )
            components = component_metrics(structural_repeat, minimum_pixels=4)
            elongated = [
                component
                for component in components
                if component["elongation"] >= 3.0 and component["area_pixels"] >= 6
            ]
            sectors.append(
                {
                    "sector": sector_name(row, col),
                    "measured_pairs": measured_pairs,
                    "structural_prior_percent": round(
                        float(structural[ys, xs].mean() * 100), 2
                    ),
                    "crop_prior_percent": round(float(crop[ys, xs].mean() * 100), 2),
                    "structural_repeat_percent": round(structural_percent, 4),
                    "crop_repeat_percent": round(crop_percent, 4),
                    "structural_vs_crop_enrichment": round(
                        (structural_percent + 0.01) / (crop_percent + 0.01), 3
                    ),
                    "robust_component_count": len(components),
                    "elongated_component_count": len(elongated),
                    "max_component_pixels": int(components[0]["area_pixels"]) if components else 0,
                    "max_component_elongation": max(
                        (float(component["elongation"]) for component in components), default=0.0
                    ),
                    "median_component_elongation": round(
                        float(
                            np.median([component["elongation"] for component in components])
                        ),
                        3,
                    )
                    if components
                    else 0.0,
                }
            )

    raw_priority = [
        float(item["structural_repeat_percent"])
        * max(float(item["structural_vs_crop_enrichment"]), 0.25)
        + 0.05 * int(item["robust_component_count"])
        + 0.10 * int(item["elongated_component_count"])
        for item in sectors
    ]
    ranks = percentile_ranks(raw_priority)
    for item, raw, rank in zip(sectors, raw_priority, ranks):
        item["raw_followup_metric"] = round(raw, 4)
        item["aoi_relative_followup_percentile"] = round(rank, 4)
    sectors.sort(key=lambda item: item["aoi_relative_followup_percentile"], reverse=True)

    result: dict[str, Any] = {
        "schema_version": SCHEMA_YEAR,
        "generated_at": utc_now(),
        "year": year,
        "scope": (
            "AI-39 broad 4x4 aggregate morphology only; no coordinates, component locations, "
            "routes, object identifications or presence claims."
        ),
        "working_scale_note": (
            "Approximately 40–60 m analysis grid after reprojection. Individual trenches, people "
            "and small equipment cannot be resolved."
        ),
        "window": [start, end],
        "inventory_items": len(items),
        "candidate_geometries": len(candidates),
        "measured_pairs": measured_pairs,
        "pair_records": pair_records,
        "landcover_identity_sha256": sha256(sorted(lc_ids)),
        "method": {
            "change": "combined VV/VH magnitude >=3 dB with 3x3 local-density suppression",
            "repeat": "change supported in at least two independently selected same-geometry pairs",
            "structural_prior": "2023 IO LULC classes built/bare/rangeland; historical prior only",
            "components": "8-neighbour connected components, minimum 4 working-grid pixels",
        },
        "sector_summary": sectors,
        "interpretation_rules": [
            "Non-crop repeat morphology is a discriminator, not proof of organized activity.",
            "2023 land cover can be stale and is never treated as 2026 truth.",
            "Elongation at this scale is not trench detection.",
            "Historical 2025 comparison is required before escalation.",
        ],
        "result_sha256": "",
    }
    seal(result, "result_sha256")
    atomic_write(out_path, result)


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
        compare_sector(current_by_sector[sector], historical_by_sector[sector])
        for sector in sorted(current_by_sector)
        if sector in historical_by_sector
    ]
    state_order = {
        "UNRESOLVED_NONCROP_REPEAT_LEAD": 3,
        "WEAK_NONCROP_DIFFERENCE": 2,
        "NO_NONCROP_ESCALATION": 1,
        "INSUFFICIENT_DATA": 0,
    }
    comparisons.sort(
        key=lambda item: (
            state_order.get(str(item["state"]), -1),
            float(item["structural_repeat_delta_pp"]),
            int(item["robust_component_count_2026"]),
        ),
        reverse=True,
    )
    d4 = next(item for item in comparisons if item["sector"] == "D4")
    if d4["state"] == "UNRESOLVED_NONCROP_REPEAT_LEAD":
        d4_conclusion = (
            "D4 survives the non-crop morphology discriminator as an unresolved broad-sector lead; "
            "it still requires independent RF/VHR or documentary corroboration."
        )
    elif d4["state"] == "NO_NONCROP_ESCALATION":
        d4_conclusion = (
            "D4 does not show a sufficiently novel non-crop repeat morphology versus the 2025 control; "
            "do not promote organized-presence confidence."
        )
    else:
        d4_conclusion = (
            "D4 remains weak after the morphology pass; current evidence does not distinguish "
            "organized activity from non-military surface processes."
        )

    result: dict[str, Any] = {
        "schema_version": SCHEMA_COMPARE,
        "generated_at": utc_now(),
        "status": "MEASURED",
        "scope": "AI-39 broad 4x4 aggregate comparison only; no component coordinates or target-level output.",
        "current_year": 2026,
        "historical_control_year": 2025,
        "comparisons": comparisons,
        "d4": d4,
        "d4_conclusion": d4_conclusion,
        "top_followups": comparisons[:6],
        "next_gap": (
            "Use an independent broad RF observation, VHR single-scene familiarization, or a "
            "document/entity signal for any sector that survives as an unresolved non-crop lead."
        ),
        "result_sha256": "",
    }
    seal(result, "result_sha256")
    atomic_write(out_path, result)
    print(
        json.dumps(
            {
                "d4": d4,
                "d4_conclusion": d4_conclusion,
                "top_followups": comparisons[:6],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI-39 SAR non-crop morphology discriminator")
    subparsers = parser.add_subparsers(dest="command", required=True)
    year_parser = subparsers.add_parser("year")
    year_parser.add_argument("--year", required=True, type=int)
    year_parser.add_argument("--max-pairs", type=int, default=4)
    year_parser.add_argument("--out", required=True)
    compare_parser = subparsers.add_parser("compare")
    compare_parser.add_argument("--current", required=True)
    compare_parser.add_argument("--historical", required=True)
    compare_parser.add_argument("--out", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "year":
        run_year(args.year, args.out, max_pairs=args.max_pairs)
        return 0
    compare(args.current, args.historical, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
