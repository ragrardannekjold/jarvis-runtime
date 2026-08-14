from __future__ import annotations

import hashlib
import unittest

import generate_daily_main_report as generator
from resilient_daily_report_runner import resilient_write_private_text_with_readback


class ResilientDailyReportReadbackTests(unittest.TestCase):
    def test_retries_transient_404_until_exact_content_is_visible(self) -> None:
        content = "private report\n"
        reads = 0
        sleeps: list[float] = []

        def read(_repo, _token, _path, *, missing_ok=False):
            nonlocal reads
            reads += 1
            if reads == 1 and missing_ok:
                return None, None
            if reads in {2, 3}:
                raise generator.ReportError("private read failed: HTTP 404")
            return content, "content-sha"

        def request(_url, _token, *, method="GET", payload=None):
            self.assertEqual(method, "PUT")
            self.assertIsInstance(payload, dict)
            return 201, {"content": {"sha": "content-sha"}}

        digest = resilient_write_private_text_with_readback(
            "owner/repo",
            "token",
            "runtime/report.json",
            content,
            message="write report",
            attempts=4,
            base_delay_seconds=0.1,
            read_function=read,
            request_function=request,
            sleep_function=sleeps.append,
        )

        self.assertEqual(digest, hashlib.sha256(content.encode("utf-8")).hexdigest())
        self.assertEqual(sleeps, [0.1, 0.2])

    def test_retries_stale_content_until_exact_match(self) -> None:
        content = "new report\n"
        readbacks = iter(["old report\n", content])
        sleeps: list[float] = []

        def read(_repo, _token, _path, *, missing_ok=False):
            if missing_ok:
                return "old report\n", "old-sha"
            return next(readbacks), "readback-sha"

        def request(_url, _token, *, method="GET", payload=None):
            self.assertEqual(method, "PUT")
            self.assertEqual(payload.get("sha"), "old-sha")
            return 200, {}

        digest = resilient_write_private_text_with_readback(
            "owner/repo",
            "token",
            "runtime/report.json",
            content,
            message="update report",
            attempts=3,
            base_delay_seconds=0.25,
            read_function=read,
            request_function=request,
            sleep_function=sleeps.append,
        )

        self.assertEqual(digest, hashlib.sha256(content.encode("utf-8")).hexdigest())
        self.assertEqual(sleeps, [0.25])

    def test_fails_closed_when_readback_never_converges(self) -> None:
        def read(_repo, _token, _path, *, missing_ok=False):
            if missing_ok:
                return None, None
            return "stale", "stale-sha"

        def request(_url, _token, *, method="GET", payload=None):
            return 201, {}

        with self.assertRaisesRegex(generator.ReportError, "did not converge"):
            resilient_write_private_text_with_readback(
                "owner/repo",
                "token",
                "runtime/report.json",
                "expected",
                message="write report",
                attempts=3,
                base_delay_seconds=0,
                read_function=read,
                request_function=request,
                sleep_function=lambda _seconds: None,
            )

    def test_rejects_invalid_retry_configuration(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least 1"):
            resilient_write_private_text_with_readback(
                "owner/repo",
                "token",
                "runtime/report.json",
                "content",
                message="write report",
                attempts=0,
            )
        with self.assertRaisesRegex(ValueError, "must not be negative"):
            resilient_write_private_text_with_readback(
                "owner/repo",
                "token",
                "runtime/report.json",
                "content",
                message="write report",
                base_delay_seconds=-1,
            )


if __name__ == "__main__":
    unittest.main()
