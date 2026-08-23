from __future__ import annotations

import unittest

from ai39_sar_noncrop_compare_v2 import classify


class SARNoncropCompareV2Tests(unittest.TestCase):
    def test_two_pairs_are_insufficient(self) -> None:
        current = {
            "sector": "D3",
            "measured_pairs": 2,
            "structural_repeat_percent": 1.0,
            "structural_vs_crop_enrichment": 4.0,
            "robust_component_count": 2,
            "max_component_pixels": 12,
        }
        historical = {
            "sector": "D3",
            "measured_pairs": 2,
            "structural_repeat_percent": 0.0,
        }
        self.assertEqual(classify(current, historical)["state"], "INSUFFICIENT_DATA")

    def test_three_pairs_and_all_gates_can_create_unresolved_lead(self) -> None:
        current = {
            "sector": "D3",
            "measured_pairs": 4,
            "structural_repeat_percent": 0.4,
            "structural_vs_crop_enrichment": 2.0,
            "robust_component_count": 1,
            "max_component_pixels": 10,
            "elongated_component_count": 0,
        }
        historical = {
            "sector": "D3",
            "measured_pairs": 3,
            "structural_repeat_percent": 0.1,
        }
        self.assertEqual(
            classify(current, historical)["state"], "UNRESOLVED_NONCROP_REPEAT_LEAD"
        )

    def test_small_component_does_not_escalate(self) -> None:
        current = {
            "sector": "D3",
            "measured_pairs": 4,
            "structural_repeat_percent": 0.5,
            "structural_vs_crop_enrichment": 3.0,
            "robust_component_count": 1,
            "max_component_pixels": 4,
            "max_component_elongation": 999.0,
            "elongated_component_count": 0,
        }
        historical = {
            "sector": "D3",
            "measured_pairs": 4,
            "structural_repeat_percent": 0.0,
        }
        result = classify(current, historical)
        self.assertEqual(result["state"], "NO_NONCROP_ESCALATION")
        self.assertIsNone(result["max_component_elongation_2026"])


if __name__ == "__main__":
    unittest.main()
