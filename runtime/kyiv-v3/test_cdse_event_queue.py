#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("cdse_event_queue", HERE / "cdse_event_queue.py")
assert SPEC and SPEC.loader
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class CDSEEventQueueTests(unittest.TestCase):
    def test_filter_is_broad_and_limited_to_sentinel_families(self):
        self.assertIn("SENTINEL-1", m.FILTER)
        self.assertIn("SENTINEL-2", m.FILTER)
        self.assertIn("OData.CSC.Intersects", m.FILTER)
        self.assertNotIn("rail", m.FILTER.lower())
        self.assertNotIn("airbase", m.FILTER.lower())

    def test_subscription_match_requires_exact_filter(self):
        good = {
            "SubscriptionType": "pull",
            "FilterParam": m.FILTER,
            "SubscriptionEvent": ["created"],
            "Status": "running",
        }
        self.assertTrue(m.subscription_matches(good))
        bad = dict(good, FilterParam="Collection/Name eq 'SENTINEL-1'")
        self.assertFalse(m.subscription_matches(bad))

    def test_summary_does_not_emit_product_identifiers(self):
        items = [
            {
                "ProductId": "secret-product-id-1",
                "ProductName": "S1A_SAMPLE",
                "NotificationDate": "2026-08-21T17:00:00Z",
                "value": {"Attributes": [{"Name": "platformShortName", "Value": "SENTINEL-1"}]},
            },
            {
                "ProductId": "secret-product-id-2",
                "ProductName": "S2A_SAMPLE",
                "NotificationDate": "2026-08-21T17:05:00Z",
                "value": {"Attributes": [{"Name": "platformShortName", "Value": "SENTINEL-2"}]},
            },
        ]
        out = m.sanitized_summary(items)
        rendered = str(out)
        self.assertEqual(out["event_count"], 2)
        self.assertEqual(out["families"], {"S1": 1, "S2": 1, "OTHER": 0})
        self.assertEqual(out["latest_notification_utc"], "2026-08-21T17:05:00Z")
        self.assertNotIn("secret-product-id", rendered)
        self.assertNotIn("S1A_SAMPLE", rendered)
        self.assertNotIn("S2A_SAMPLE", rendered)

    def test_missing_credentials_is_nonfatal_disabled_state(self):
        old_u, old_p = m.os.environ.pop("CDSE_USERNAME", None), m.os.environ.pop("CDSE_PASSWORD", None)
        try:
            result = m.run()
            self.assertEqual(result.state, "DISABLED_MISSING_CDSE_CREDENTIALS")
            self.assertFalse(result.dispatched)
            self.assertFalse(result.acknowledged)
        finally:
            if old_u is not None:
                m.os.environ["CDSE_USERNAME"] = old_u
            if old_p is not None:
                m.os.environ["CDSE_PASSWORD"] = old_p


if __name__ == "__main__":
    unittest.main()
