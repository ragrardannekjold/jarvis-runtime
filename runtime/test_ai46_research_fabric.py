from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ai46_research_fabric import (
    AGGREGATE_SCHEMA,
    ENVELOPE_SCHEMA,
    MISSION_SCHEMA,
    aggregate_results,
    calibrate_sector_metrics,
    compile_mission,
    load_envelope,
    percentile_ranks,
    safe_payload,
    seal_document,
    stable_mission_id,
    validate_sealed,
    write_envelope,
)


class AI46ResearchFabricTests(unittest.TestCase):
    def test_mission_is_stable_and_sealed(self) -> None:
        first = compile_mission()
        second = compile_mission()
        self.assertEqual(first["schema_version"], MISSION_SCHEMA)
        self.assertEqual(first["mission_id"], second["mission_id"])
        validate_sealed(first, "mission_sha256")
        self.assertEqual(
            stable_mission_id(first["objective"], first["safe_scope"]),
            first["mission_id"],
        )

    def test_safe_payload_removes_targetable_fields(self) -> None:
        cleaned = safe_payload(
            {
                "claim": "aggregate",
                "ip": "192.0.2.1",
                "nested": {
                    "latitude": 1.0,
                    "longitude": 2.0,
                    "banner": "raw",
                    "port_class": "web",
                },
                "items": [{"hostnames": ["example"], "count": 3}],
            }
        )
        self.assertNotIn("ip", cleaned)
        self.assertNotIn("latitude", cleaned["nested"])
        self.assertNotIn("longitude", cleaned["nested"])
        self.assertNotIn("banner", cleaned["nested"])
        self.assertEqual(cleaned["nested"]["port_class"], "web")
        self.assertNotIn("hostnames", cleaned["items"][0])

    def test_envelope_roundtrip_is_hash_verified_and_sanitized(self) -> None:
        mission = compile_mission()
        envelope = {
            "schema_version": ENVELOPE_SCHEMA,
            "fabric_version": "AI46_RESEARCH_FABRIC_V0_1",
            "mission_id": mission["mission_id"],
            "worker_id": "test",
            "source_class": "TEST",
            "started_at": "2026-08-23T00:00:00Z",
            "completed_at": None,
            "status": "VERIFIED_DONE",
            "provider_status": {"fixture": "OK"},
            "observations": {"ip": "192.0.2.1", "count": 1},
            "claims": [],
            "evidence_refs": ["fixture"],
            "errors": [],
            "external_side_effects": False,
            "safe_output": True,
            "envelope_sha256": "",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "envelope.json"
            write_envelope(path, envelope)
            loaded = load_envelope(path)
        self.assertNotIn("ip", loaded["observations"])
        validate_sealed(loaded, "envelope_sha256")

    def test_relative_calibration_does_not_saturate(self) -> None:
        cells = []
        for index in range(16):
            cells.append(
                {
                    "sector": f"S{index}",
                    "elev_p05_p95_range_m": 10 + index,
                    "slope_median_deg": 1 + index / 10,
                    "local_relief_p95_abs_m": 0.5 + index / 20,
                    "roughness_p95_m": 0.7 + index / 30,
                }
            )
        calibrated = calibrate_sector_metrics(cells)
        scores = [cell["terrain_confound_percentile"] for cell in calibrated]
        self.assertLess(min(scores), 0.1)
        self.assertGreater(max(scores), 0.9)
        self.assertGreater(len(set(scores)), 12)

    def test_percentile_ranks_handle_ties(self) -> None:
        ranks = percentile_ranks([1.0, 1.0, 2.0, 3.0])
        self.assertEqual(len(ranks), 4)
        self.assertEqual(ranks[0], ranks[1])
        self.assertLess(ranks[0], ranks[2])
        self.assertLess(ranks[2], ranks[3])

    def test_aggregate_survives_missing_workers_and_updates_alternative(self) -> None:
        mission = compile_mission()
        envelope = {
            "schema_version": ENVELOPE_SCHEMA,
            "fabric_version": "AI46_RESEARCH_FABRIC_V0_1",
            "mission_id": mission["mission_id"],
            "worker_id": "terrain",
            "source_class": "EO_TERRAIN",
            "started_at": "2026-08-23T00:00:00Z",
            "completed_at": "2026-08-23T00:01:00Z",
            "status": "VERIFIED_DONE",
            "provider_status": {"planetary_computer": "OK"},
            "observations": {},
            "claims": [
                {
                    "claim_id": "AI39-D4-TERRAIN-CONFOUND",
                    "candidate_id": "D4",
                    "state": "SUPPORTED",
                    "confidence": 0.68,
                    "alternative": "terrain_artifact",
                    "alternative_weight_delta": -0.15,
                    "statement": "D4 is in the low-relief tail.",
                }
            ],
            "evidence_refs": ["Copernicus DEM GLO-30"],
            "errors": [],
            "external_side_effects": False,
            "safe_output": True,
            "envelope_sha256": "",
        }
        seal_document(envelope, "envelope_sha256")
        aggregate = aggregate_results(mission, [envelope])
        self.assertEqual(aggregate["schema_version"], AGGREGATE_SCHEMA)
        self.assertEqual(aggregate["status"], "PARTIAL_SUCCESS")
        self.assertEqual(aggregate["worker_count_accepted"], 1)
        self.assertEqual(aggregate["decision_change_count"], 1)
        self.assertAlmostEqual(
            aggregate["candidate_ledger"]["D4"]["terrain_artifact_weight"], 0.30
        )
        self.assertEqual(
            aggregate["candidate_ledger"]["D4"]["organized_presence_confidence"], 0.32
        )
        validate_sealed(aggregate, "aggregate_sha256")

    def test_invalid_envelope_is_rejected_without_crashing(self) -> None:
        mission = compile_mission()
        invalid = {
            "schema_version": ENVELOPE_SCHEMA,
            "mission_id": mission["mission_id"],
            "worker_id": "broken",
            "envelope_sha256": "0" * 64,
        }
        aggregate = aggregate_results(mission, [invalid])
        self.assertEqual(aggregate["status"], "FAILED")
        self.assertEqual(aggregate["worker_count_rejected"], 1)


if __name__ == "__main__":
    unittest.main()
