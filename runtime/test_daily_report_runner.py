from datetime import datetime
import unittest
from zoneinfo import ZoneInfo

from runtime.daily_report_runner import due_state


class DailyReportRunnerTests(unittest.TestCase):
    def test_due_states_are_local_date_idempotent(self) -> None:
        timezone = ZoneInfo("Europe/Kyiv")
        self.assertEqual(
            due_state(
                now=datetime(2026, 8, 14, 19, 59, tzinfo=timezone),
                report_label_local_time="20:00",
                existing_report=None,
            ),
            "NOT_DUE",
        )
        self.assertEqual(
            due_state(
                now=datetime(2026, 8, 14, 20, 0, tzinfo=timezone),
                report_label_local_time="20:00",
                existing_report=None,
            ),
            "DUE",
        )
        self.assertEqual(
            due_state(
                now=datetime(2026, 8, 14, 23, 0, tzinfo=timezone),
                report_label_local_time="20:00",
                existing_report={"local_date": "2026-08-14"},
            ),
            "ALREADY_PUBLISHED",
        )

    def test_manual_force_is_explicit(self) -> None:
        timezone = ZoneInfo("Europe/Kyiv")
        self.assertEqual(
            due_state(
                now=datetime(2026, 8, 14, 10, 0, tzinfo=timezone),
                report_label_local_time="20:00",
                existing_report={"local_date": "2026-08-14"},
                force=True,
            ),
            "FORCE_REBUILD",
        )


if __name__ == "__main__":
    unittest.main()
