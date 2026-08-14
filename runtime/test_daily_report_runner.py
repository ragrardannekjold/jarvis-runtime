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
                target_local_time="20:00",
                latest_report=None,
            ),
            "NOT_DUE",
        )
        self.assertEqual(
            due_state(
                now=datetime(2026, 8, 14, 20, 0, tzinfo=timezone),
                target_local_time="20:00",
                latest_report=None,
            ),
            "DUE",
        )
        self.assertEqual(
            due_state(
                now=datetime(2026, 8, 14, 23, 0, tzinfo=timezone),
                target_local_time="20:00",
                latest_report={"local_date": "2026-08-14"},
            ),
            "ALREADY_PUBLISHED",
        )


if __name__ == "__main__":
    unittest.main()
