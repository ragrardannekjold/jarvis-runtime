#!/usr/bin/env python3
from __future__ import annotations

import unittest

from suppression_watch import build_public_suppression_watch, telegram_posts


def page(channel: str, post_id: int, published: str, text: str) -> str:
    return (
        f'<div class="tgme_widget_message" data-post="{channel}/{post_id}">'
        f'<time datetime="{published}"></time>'
        f'<div class="tgme_widget_message_text">{text}</div></div>'
    )


class SuppressionWatchTests(unittest.TestCase):
    anchor = "2026-08-17T02:00:00Z"

    def test_recent_official_launch_chain_strike_opens_watch_but_not_risk(self):
        source = page(
            "GeneralStaffZSU",
            100,
            "2026-08-17T00:30:00Z",
            "Уражено тактичну групу ОТРК Іскандер у Курській області.",
        )
        state = build_public_suppression_watch(ukrainian_page=source, aggressor_pages={}, anchor_utc=self.anchor)
        self.assertEqual(state["collection_status"], "VERIFIED_DONE")
        self.assertEqual(state["action"], "OPEN_SUPPRESSION_WATCH")
        self.assertEqual(state["candidate_region_buckets"], ["KUR"])
        self.assertEqual(state["evidence_effect"], "NONE")
        self.assertEqual(state["applied_delta_points"], 0)
        self.assertFalse(state["current_threat_state_updated"])
        self.assertNotIn("raw_text", state)

    def test_enemy_attack_recap_does_not_open_watch(self):
        source = page(
            "GeneralStaffZSU",
            101,
            "2026-08-17T00:40:00Z",
            "Ворог завдав удару балістичною ракетою Іскандер-М.",
        )
        state = build_public_suppression_watch(ukrainian_page=source, aggressor_pages={}, anchor_utc=self.anchor)
        self.assertEqual(state["action"], "ROUTINE_PUBLIC_SCAN")
        self.assertEqual(state["candidate_count_6h"], 0)

    def test_stale_or_future_report_does_not_open_watch(self):
        stale = page("GeneralStaffZSU", 102, "2026-08-16T18:00:00Z", "Уражено пускову установку ОТРК Іскандер.")
        future = page("GeneralStaffZSU", 103, "2026-08-17T03:00:00Z", "Уражено пускову установку ОТРК Іскандер.")
        for source in (stale, future):
            with self.subTest(source=source):
                state = build_public_suppression_watch(ukrainian_page=source, aggressor_pages={}, anchor_utc=self.anchor)
                self.assertEqual(state["action"], "ROUTINE_PUBLIC_SCAN")

    def test_aggressor_physical_or_function_markers_remain_unlinked_and_zero_effect(self):
        source = page("GeneralStaffZSU", 104, "2026-08-17T00:20:00Z", "Уражено пускову установку ОТРК Іскандер.")
        mod = page("mod_russia", 200, "2026-08-17T01:00:00Z", "После атаки возник пожар, работа остановлена.")
        mchs = page("mchs_official", 300, "2026-08-17T01:10:00Z", "Ликвидация возгорания продолжается.")
        state = build_public_suppression_watch(
            ukrainian_page=source,
            aggressor_pages={"mod_russia": mod, "mchs_official": mchs},
            anchor_utc=self.anchor,
        )
        self.assertEqual(state["aggressor_readback"]["RUSSIAN_MOD_PUBLIC"]["classification"], "UNLINKED_FUNCTION_STOP_MARKER_OBSERVED")
        self.assertFalse(state["aggressor_readback"]["RUSSIAN_MOD_PUBLIC"]["functional_bda_qualified"])
        self.assertEqual(state["applied_delta_points"], 0)

    def test_parser_returns_only_requested_channel(self):
        mixed = page("GeneralStaffZSU", 1, "2026-08-17T00:00:00Z", "Один") + page("other", 2, "2026-08-17T00:01:00Z", "Два")
        posts = telegram_posts(mixed, "GeneralStaffZSU")
        self.assertEqual([post["post_id"] for post in posts], ["1"])


if __name__ == "__main__":
    unittest.main()
