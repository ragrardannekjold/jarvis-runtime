from __future__ import annotations

import unittest

from select_daily_report_mode import ModeSelectionError, select_mode


class DailyReportModeSelectionTests(unittest.TestCase):
    def test_commit_marker_selects_verification_without_changed_file_list(self) -> None:
        payload = {
            "head_commit": {
                "message": "[main-daily-report:verification] verify private readback",
                "added": [],
                "modified": [],
                "removed": [],
            }
        }
        self.assertEqual(select_mode(event_name="push", payload=payload), "verification")

    def test_trigger_file_remains_a_fallback(self) -> None:
        payload = {
            "head_commit": {
                "message": "ordinary maintenance commit",
                "modified": ["runtime/daily-report-verify-trigger.txt"],
            }
        }
        self.assertEqual(select_mode(event_name="push", payload=payload), "verification")

    def test_ordinary_push_and_pull_request_are_dry_runs(self) -> None:
        self.assertEqual(
            select_mode(
                event_name="push",
                payload={"head_commit": {"message": "ordinary commit"}},
            ),
            "dry-run",
        )
        self.assertEqual(select_mode(event_name="pull_request", payload={}), "dry-run")

    def test_schedule_is_final(self) -> None:
        self.assertEqual(select_mode(event_name="schedule", payload={}), "final")

    def test_workflow_dispatch_requires_an_allowed_mode(self) -> None:
        self.assertEqual(
            select_mode(
                event_name="workflow_dispatch",
                payload={},
                dispatch_mode="verification",
            ),
            "verification",
        )
        with self.assertRaisesRegex(ModeSelectionError, "workflow_dispatch mode"):
            select_mode(
                event_name="workflow_dispatch",
                payload={},
                dispatch_mode="unknown",
            )


if __name__ == "__main__":
    unittest.main()
