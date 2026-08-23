from __future__ import annotations

import unittest

from ai39_asn_transition import limited_facets, related_operator, score_transition


class ASNTransitionTests(unittest.TestCase):
    def test_limited_facets_sanitizes_shape(self) -> None:
        result = limited_facets(
            [
                {"value": "nginx", "count": 3, "extra": "drop"},
                {"value": "Apache", "count": 2},
                {"value": None, "count": 1},
            ],
            10,
        )
        self.assertEqual(
            result,
            [
                {"value": "nginx", "count": 3},
                {"value": "Apache", "count": 2},
            ],
        )

    def test_related_operator_requires_both_sides(self) -> None:
        legacy = {
            "whois": {
                "fields": {
                    "as-name": ["KOMTEL-DPR-AS"],
                    "org": ["ORG-SUEO4-RIPE"],
                    "country": ["RU"],
                    "descr": ["Donetsk"],
                }
            }
        }
        phoenix = {
            "whois": {
                "fields": {
                    "as-name": ["PHOENIX-AS"],
                    "org-name": ["Republican Telecommunications Operator"],
                    "descr": ["Donetsk"],
                }
            }
        }
        relation = related_operator(legacy, phoenix)
        self.assertTrue(relation["same_broad_operator_family_lead"])

    def test_score_transition_supports_role_shift_when_new_asn_is_larger(self) -> None:
        result = {
            "relationship": {"same_broad_operator_family_lead": True},
            "shodan": {
                "legacy": {"current_total": 15},
                "phoenix": {"current_total": 100},
            },
        }
        assessment = score_transition(result)
        self.assertEqual(
            assessment["state"], "SUPPORTED_ASN_ROLE_SHIFT_OR_MIGRATION_LEAD"
        )
        self.assertGreater(assessment["confidence"], 0.7)
        self.assertEqual(assessment["current_total_legacy"], 15)
        self.assertEqual(assessment["current_total_phoenix"], 100)

    def test_score_transition_keeps_dual_asn_state_unresolved(self) -> None:
        result = {
            "relationship": {"same_broad_operator_family_lead": True},
            "shodan": {
                "legacy": {"current_total": 15},
                "phoenix": {"current_total": 10},
            },
        }
        assessment = score_transition(result)
        self.assertEqual(assessment["state"], "UNRESOLVED_DUAL_ASN_RESTRUCTURING")

    def test_score_transition_does_not_infer_without_relationship(self) -> None:
        result = {
            "relationship": {"same_broad_operator_family_lead": False},
            "shodan": {
                "legacy": {"current_total": 15},
                "phoenix": {"current_total": 500},
            },
        }
        assessment = score_transition(result)
        self.assertEqual(assessment["state"], "INSUFFICIENT_RELATIONSHIP_EVIDENCE")


if __name__ == "__main__":
    unittest.main()
