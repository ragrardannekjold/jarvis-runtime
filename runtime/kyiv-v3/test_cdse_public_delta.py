#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
SPEC = importlib.util.spec_from_file_location("cdse_public_delta", HERE / "cdse_public_delta.py")
assert SPEC and SPEC.loader
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class CDSEPublicDeltaTests(unittest.TestCase):
    def test_odata_time_is_utc_and_precise(self):
        d = datetime(2026, 8, 21, 17, 5, 3, 123456, tzinfo=timezone.utc)
        self.assertEqual(m.odata_time(d), "2026-08-21T17:05:03.123456Z")

    def test_normalization_drops_geo_fields(self):
        products = [{
            "Id": "abc",
            "Name": "S1A_SAMPLE",
            "PublicationDate": "2026-08-21T17:05:00Z",
            "GeoFootprint": {"type": "Polygon", "coordinates": [[1, 2]]},
        }]
        out = m.normalized_public_items(products)
        self.assertEqual(set(out[0]), {"ProductId", "ProductName", "NotificationDate"})
        self.assertNotIn("GeoFootprint", str(out))

    def test_run_dispatches_only_when_new_publication_exists(self):
        old_token = m.os.environ.get("GITHUB_TOKEN")
        old_repo = m.os.environ.get("GITHUB_REPOSITORY")
        m.os.environ["GITHUB_TOKEN"] = "test-token"
        m.os.environ["GITHUB_REPOSITORY"] = "owner/repo"
        calls = []
        old_latest = m.github_latest_v3_created
        old_products = m.public_products_since
        old_dispatch = m.q.dispatch_refresh
        try:
            m.github_latest_v3_created = lambda *_: datetime(2026, 8, 21, 17, 0, tzinfo=timezone.utc)
            m.public_products_since = lambda *_: [{"Id": "abc", "Name": "S1A_SAMPLE", "PublicationDate": "2026-08-21T17:05:00Z"}]
            m.q.dispatch_refresh = lambda token, repo: calls.append((token, repo))
            result = m.run()
            self.assertEqual(result.state, "PUBLICATION_DELTA_REFRESH_DISPATCHED")
            self.assertTrue(result.dispatched)
            self.assertEqual(result.event_count, 1)
            self.assertEqual(calls, [("test-token", "owner/repo")])
        finally:
            m.github_latest_v3_created = old_latest
            m.public_products_since = old_products
            m.q.dispatch_refresh = old_dispatch
            if old_token is None:
                m.os.environ.pop("GITHUB_TOKEN", None)
            else:
                m.os.environ["GITHUB_TOKEN"] = old_token
            if old_repo is None:
                m.os.environ.pop("GITHUB_REPOSITORY", None)
            else:
                m.os.environ["GITHUB_REPOSITORY"] = old_repo

    def test_no_publications_means_no_dispatch(self):
        old_token = m.os.environ.get("GITHUB_TOKEN")
        old_repo = m.os.environ.get("GITHUB_REPOSITORY")
        m.os.environ["GITHUB_TOKEN"] = "test-token"
        m.os.environ["GITHUB_REPOSITORY"] = "owner/repo"
        old_latest = m.github_latest_v3_created
        old_products = m.public_products_since
        try:
            m.github_latest_v3_created = lambda *_: datetime(2026, 8, 21, 17, 0, tzinfo=timezone.utc)
            m.public_products_since = lambda *_: []
            result = m.run()
            self.assertEqual(result.state, "NO_NEW_PUBLICATIONS")
            self.assertFalse(result.dispatched)
        finally:
            m.github_latest_v3_created = old_latest
            m.public_products_since = old_products
            if old_token is None:
                m.os.environ.pop("GITHUB_TOKEN", None)
            else:
                m.os.environ["GITHUB_TOKEN"] = old_token
            if old_repo is None:
                m.os.environ.pop("GITHUB_REPOSITORY", None)
            else:
                m.os.environ["GITHUB_REPOSITORY"] = old_repo


if __name__ == "__main__":
    unittest.main()
