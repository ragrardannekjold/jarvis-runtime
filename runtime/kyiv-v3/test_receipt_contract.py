#!/usr/bin/env python3
from __future__ import annotations

import copy
import unittest
from datetime import datetime, timedelta, timezone

from receipt_contract import (
    RESULT_SEMANTICS,
    build_receipt,
    clamp_expected_bin_end,
    finalize_json_receipt,
    set_receipt_result,
    validate_receipts,
)


class ReceiptContractTests(unittest.TestCase):
    def setUp(self):
        self.run_id = "KYIV-RUNTIME-123-A1"
        self.started = datetime(2026, 8, 17, 0, 0, tzinfo=timezone.utc)
        self.ended = self.started + timedelta(seconds=2)

    def canonical(self, query_id="IODA active probing BRY", semantic="NO_DELTA_OBSERVED"):
        row = build_receipt(
            run_id=self.run_id,
            url="https://example.test/data?from=1786924800&until=1786928400&token=secret-value",
            measurement_class="active_probing_reachability",
            query_id=query_id,
            started=self.started,
            ended=self.ended,
            http_status=200,
            raw=b'{"data":[{"timestamp":"2026-08-17T00:00:01Z"}]}',
            elapsed_ms=2000,
            error=None,
        )
        finalize_json_receipt(row, {"data": [{"timestamp": "2026-08-17T00:00:01Z"}]}, schema_id="TEST")
        if semantic in {"DELTA_PRESENT", "NO_DELTA_OBSERVED"}:
            set_receipt_result(row, semantic, "TEST_OBSERVATION", observation_opportunity=True, source_latest=self.started + timedelta(seconds=1), record_count=1)
        else:
            set_receipt_result(row, semantic, "TEST_NON_ASSERTION", observation_opportunity=False, source_latest=self.started + timedelta(seconds=1), record_count=1)
        return row

    def assert_failed(self, rows, run_id=None):
        result = validate_receipts(rows, self.run_id if run_id is None else run_id)
        self.assertFalse(result["schema_passed"], result)
        self.assertGreater(result["error_count"], 0)
        return result

    def test_legacy_receipt_rejected_even_with_valid_digest(self):
        legacy = {
            "class": "active_probing_reachability",
            "semantic": "IODA active probing BRY",
            "started_utc": "2026-08-17T00:00:00Z",
            "ended_utc": "2026-08-17T00:00:01Z",
            "host": "example.test",
            "path": "/data",
            "status": 200,
            "bytes": 1,
            "elapsed_ms": 1,
            "sha256": "0" * 64,
            "error": None,
        }
        result = self.assert_failed([legacy])
        self.assertTrue(any(error["field"] == "run_id" for error in result["errors"]))

    def test_canonical_receipt_passes(self):
        result = validate_receipts([self.canonical()], self.run_id)
        self.assertTrue(result["schema_passed"], result)
        self.assertTrue(result["run_linkage_passed"])
        self.assertTrue(result["semantic_enum_passed"])
        self.assertTrue(result["unique_receipt_ids_passed"])

    def test_mixed_or_stale_run_ids_rejected(self):
        first = self.canonical()
        second = self.canonical("IODA active probing KUR")
        second["run_id"] = "KYIV-RUNTIME-OLD-A1"
        result = self.assert_failed([first, second])
        self.assertFalse(result["run_linkage_passed"])

    def test_missing_top_level_run_id_rejected(self):
        result = self.assert_failed([self.canonical()], run_id="")
        self.assertFalse(result["run_linkage_passed"])

    def test_invalid_or_prose_result_semantic_rejected(self):
        row = self.canonical()
        row["result_semantic"] = "IODA region relation BRY"
        result = self.assert_failed([row])
        self.assertFalse(result["semantic_enum_passed"])

    def test_every_result_semantic_enum_member_is_accepted(self):
        rows = [self.canonical(f"query-{index}", semantic) for index, semantic in enumerate(sorted(RESULT_SEMANTICS), 1)]
        result = validate_receipts(rows, self.run_id)
        self.assertTrue(result["schema_passed"], result)

    def test_duplicate_receipt_id_rejected(self):
        first = self.canonical()
        second = self.canonical("IODA active probing KUR")
        second["receipt_id"] = first["receipt_id"]
        result = self.assert_failed([first, second])
        self.assertFalse(result["unique_receipt_ids_passed"])

    def test_negative_semantic_requires_fresh_observation(self):
        row = self.canonical()
        row["freshness"]["status"] = "UNKNOWN"
        result = self.assert_failed([row])
        self.assertTrue(any(error["reason"] == "ASSERTED_WITHOUT_FRESHNESS" for error in result["errors"]))

    def test_parser_failure_cannot_be_negative_evidence(self):
        row = self.canonical()
        row["parser"] = {"status": "JSON_PARSE_FAILED", "schema_id": None, "error": "ValueError"}
        result = self.assert_failed([row])
        self.assertTrue(any(error["reason"] == "ASSERTED_WITHOUT_OBSERVATION_OPPORTUNITY" for error in result["errors"]))

    def test_request_secrets_and_broad_bbox_are_redacted(self):
        row = build_receipt(
            run_id=self.run_id,
            url="https://example.test/search?api_key=hidden",
            measurement_class="geoint_catalog",
            query_id="STAC sar BRY-P1-01",
            started=self.started,
            ended=self.ended,
            http_status=200,
            raw=b"{}",
            elapsed_ms=1,
            error=None,
            payload={"bbox": [1, 2, 3, 4], "collections": ["sentinel-1-grd"]},
        )
        self.assertEqual(row["request"]["parameters_redacted"]["api_key"], "REDACTED")
        self.assertEqual(row["request"]["body_redacted"]["bbox"], "REDACTED_BROAD_ADMIN_TILE_USE_QUERY_ID_AND_CONFIG_HASH")
        self.assertNotIn("hidden", str(row["request"]["parameters_redacted"]))

    def test_telegram_channels_keep_distinct_source_lineages(self):
        rows = []
        for channel in ("GeneralStaffZSU", "mod_russia", "mchs_official", "favt_info"):
            row = build_receipt(
                run_id=self.run_id,
                url=f"https://t.me/s/{channel}",
                measurement_class="documentary_public_aggregate",
                query_id=f"public scan {channel}",
                started=self.started,
                ended=self.ended,
                http_status=200,
                raw=b"page",
                elapsed_ms=1,
                error=None,
            )
            rows.append(row)
        self.assertEqual(len({row["source_lineage"] for row in rows}), 4)
        self.assertEqual(rows[0]["collector_id"], "UA_GENERAL_STAFF_PUBLIC")
        self.assertEqual(rows[1]["collector_id"], "RUSSIAN_MOD_PUBLIC")

    def test_started_after_ended_rejected(self):
        row = self.canonical()
        row["ended_utc"] = "2026-08-16T23:59:59Z"
        result = self.assert_failed([row])
        self.assertTrue(any(error["reason"] == "BEFORE_START" for error in result["errors"]))

    def test_expected_ten_minute_bin_end_is_clamped_but_larger_future_is_quarantined(self):
        clamped,state=clamp_expected_bin_end(self.started+timedelta(minutes=10),self.started)
        self.assertEqual(clamped,self.started)
        self.assertEqual(state,"EXPECTED_BIN_END_LABEL_CLAMPED")
        quarantined,state=clamp_expected_bin_end(self.started+timedelta(minutes=16),self.started)
        self.assertIsNone(quarantined)
        self.assertEqual(state,"FUTURE_LABEL_QUARANTINED")

    def test_augment_style_row_preserves_single_run_id(self):
        collector_row = self.canonical()
        augment_row = copy.deepcopy(self.canonical("IODA BGP aggregate routing fallback BRY"))
        augment_row["measurement_class"] = "routing_control_plane_fallback"
        result = validate_receipts([collector_row, augment_row], self.run_id)
        self.assertTrue(result["schema_passed"], result)
        self.assertEqual({collector_row["run_id"], augment_row["run_id"]}, {self.run_id})


if __name__ == "__main__":
    unittest.main()
