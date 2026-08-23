from __future__ import annotations

import unittest

from ai39_asn_transition_v2 import assess, exact_org_relationship


class ASNTransitionV2Tests(unittest.TestCase):
    def test_exact_common_org_establishes_relationship(self) -> None:
        result = {
            "ripe": {
                "legacy": {"whois": {"fields": {"org": ["ORG-SUEO4-RIPE"], "as-name": ["KOMTEL-DPR-AS"]}}},
                "phoenix": {"whois": {"fields": {"org": ["ORG-SUEO4-RIPE"], "as-name": ["PHOENIX-AS"]}}},
            }
        }
        relationship = exact_org_relationship(result)
        self.assertTrue(relationship["same_ripe_org"])
        self.assertEqual(relationship["common_ripe_orgs"], ["org-sueo4-ripe"])

    def test_synchronous_collapse_supports_operator_wide_change_not_migration(self) -> None:
        result = {
            "prior_verified_legacy_trend": {
                "monthly_2026": {"2026-01": 488, "2026-03": 14}
            },
            "shodan": {
                "legacy": {"current_total": 15},
                "phoenix": {"current_total": 6},
                "phoenix_trend": {
                    "monthly": [
                        {"month": "2026-01", "count": 85},
                        {"month": "2026-03", "count": 11},
                    ]
                },
            },
            "ripe": {
                "legacy": {"announced_prefix_count": 9},
                "phoenix": {"announced_prefix_count": 16},
            },
        }
        relationship = {"same_ripe_org": True}
        assessment = assess(result, relationship)
        self.assertEqual(
            assessment["state"],
            "SUPPORTED_OPERATOR_WIDE_EXPOSURE_POLICY_OR_RESTRUCTURING",
        )
        self.assertEqual(
            assessment["migration_hypothesis"], "NOT_SUPPORTED_BY_CURRENT_EXPOSURE"
        )
        self.assertGreater(assessment["legacy_jan_to_mar_collapse_fraction"], 0.9)
        self.assertGreater(assessment["phoenix_jan_to_mar_collapse_fraction"], 0.8)

    def test_common_org_without_trend_stays_unresolved(self) -> None:
        result = {
            "prior_verified_legacy_trend": {"monthly_2026": {}},
            "shodan": {
                "legacy": {"current_total": 15},
                "phoenix": {"current_total": 6},
            },
            "ripe": {"legacy": {}, "phoenix": {}},
        }
        assessment = assess(result, {"same_ripe_org": True})
        self.assertEqual(assessment["state"], "UNRESOLVED_DUAL_ASN_RESTRUCTURING")

    def test_no_common_org_fails_closed(self) -> None:
        result = {"ripe": {"legacy": {}, "phoenix": {}}, "shodan": {}}
        relationship = exact_org_relationship(result)
        self.assertFalse(relationship["same_ripe_org"])
        assessment = assess(result, relationship)
        self.assertEqual(assessment["state"], "INSUFFICIENT_RELATIONSHIP_EVIDENCE")


if __name__ == "__main__":
    unittest.main()
