from __future__ import annotations

import unittest

from ai39_allied_sanctions_entity_pass import dedupe, normalize, score


class AlliedSanctionsEntityPassTests(unittest.TestCase):
    def test_normalize_handles_punctuation_and_case(self) -> None:
        self.assertEqual(
            normalize("Republican Telecommunications Operator"),
            "republican telecommunications operator",
        )
        self.assertIn("республиканскии", normalize("Республиканский оператор связи"))

    def test_exact_substring_scores_one(self) -> None:
        match_score, method = score(
            "Republican Telecommunications Operator",
            "STATE UNITARY ENTERPRISE — Republican Telecommunications Operator",
        )
        self.assertEqual(match_score, 1.0)
        self.assertEqual(method, "SUBSTRING")

    def test_unrelated_name_does_not_score_high(self) -> None:
        match_score, _ = score("KOMTEL", "Commercial Bank of Example")
        self.assertLess(match_score, 0.5)

    def test_transliteration_has_partial_similarity(self) -> None:
        match_score, _ = score(
            "Respublikanskiy Operator Svyazi",
            "Respublikansky Operator Svyazi",
        )
        self.assertGreater(match_score, 0.8)

    def test_dedupe_preserves_distinct_sources(self) -> None:
        matches = [
            {
                "source": "one",
                "record_id": "1",
                "search_term": "KOMTEL",
                "record_excerpt": "KOMTEL",
                "match_score": 1.0,
            },
            {
                "source": "one",
                "record_id": "1",
                "search_term": "KOMTEL",
                "record_excerpt": "KOMTEL",
                "match_score": 1.0,
            },
            {
                "source": "two",
                "record_id": "1",
                "search_term": "KOMTEL",
                "record_excerpt": "KOMTEL",
                "match_score": 1.0,
            },
        ]
        result = dedupe(matches)
        self.assertEqual(len(result), 2)


if __name__ == "__main__":
    unittest.main()
