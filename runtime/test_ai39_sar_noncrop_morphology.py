from __future__ import annotations

import unittest

import numpy as np

from ai39_sar_noncrop_morphology import (
    compare_sector,
    component_metrics,
    percentile_ranks,
    seal,
    validate_seal,
)


class SARNoncropMorphologyTests(unittest.TestCase):
    def test_component_metrics_distinguish_line_and_block(self) -> None:
        mask = np.zeros((20, 20), dtype=bool)
        mask[2:4, 2:15] = True
        mask[10:15, 10:15] = True
        metrics = component_metrics(mask, minimum_pixels=4)
        self.assertEqual(len(metrics), 2)
        self.assertGreater(max(item["elongation"] for item in metrics), 3.0)
        self.assertGreater(max(item["area_pixels"] for item in metrics), 20)

    def test_percentile_ranks_are_relative_not_saturated(self) -> None:
        ranks = percentile_ranks(range(16))
        self.assertEqual(len(set(ranks)), 16)
        self.assertEqual(ranks[0], 0.0)
        self.assertEqual(ranks[-1], 1.0)

    def test_compare_sector_promotes_only_with_multiple_conditions(self) -> None:
        current = {
            "sector": "D4",
            "measured_pairs": 4,
            "structural_repeat_percent": 0.8,
            "structural_vs_crop_enrichment": 2.0,
            "robust_component_count": 2,
            "elongated_component_count": 1,
            "max_component_pixels": 20,
            "max_component_elongation": 4.2,
        }
        historical = {
            "sector": "D4",
            "measured_pairs": 4,
            "structural_repeat_percent": 0.2,
        }
        result = compare_sector(current, historical)
        self.assertEqual(result["state"], "UNRESOLVED_NONCROP_REPEAT_LEAD")

    def test_compare_sector_rejects_no_component_escalation(self) -> None:
        current = {
            "sector": "D4",
            "measured_pairs": 4,
            "structural_repeat_percent": 0.8,
            "structural_vs_crop_enrichment": 3.0,
            "robust_component_count": 0,
            "elongated_component_count": 0,
        }
        historical = {
            "sector": "D4",
            "measured_pairs": 4,
            "structural_repeat_percent": 0.1,
        }
        result = compare_sector(current, historical)
        self.assertEqual(result["state"], "NO_NONCROP_ESCALATION")

    def test_compare_sector_requires_historical_support(self) -> None:
        current = {
            "sector": "D4",
            "measured_pairs": 4,
            "structural_repeat_percent": 1.0,
            "structural_vs_crop_enrichment": 3.0,
            "robust_component_count": 2,
            "elongated_component_count": 1,
        }
        historical = {
            "sector": "D4",
            "measured_pairs": 1,
            "structural_repeat_percent": 0.0,
        }
        result = compare_sector(current, historical)
        self.assertEqual(result["state"], "INSUFFICIENT_DATA")

    def test_sealed_document_detects_drift(self) -> None:
        document = seal({"value": 1, "result_sha256": ""}, "result_sha256")
        validate_seal(document, "result_sha256")
        document["value"] = 2
        with self.assertRaises(ValueError):
            validate_seal(document, "result_sha256")


if __name__ == "__main__":
    unittest.main()
