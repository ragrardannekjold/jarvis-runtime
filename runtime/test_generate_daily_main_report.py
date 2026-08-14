from __future__ import annotations

import csv
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from generate_daily_main_report import (
    _active_user_actions,
    _build_report,
    _render_markdown,
)


AUTHORITY_SHA = "a" * 64
POLICY_SHA = "b" * 64


class DailyMainReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "checkpoints").mkdir(parents=True)
        (self.root / "registry").mkdir(parents=True)
        (self.root / "archive/results/records").mkdir(parents=True)

        (self.root / "checkpoints/CURRENT_CHECKPOINT.md").write_text(
            """# Current Checkpoint

**Timestamp:** 2026-08-14 19:25 Europe/Kyiv  
**Checkpoint version:** 33  
**Recovery generation:** 9  
**System health:** `DEGRADED_RECOVERING / STABLE_FALLBACK_ACTIVE`

Current recognized revenue remains **0** absent newer direct payment evidence.

## Current stable commercial mode

**State:** `CONVERSION_DEGRADED / DELIVERABILITY_DEGRADED / RECOVERY`.

## Primary WIP

**JCC-004 — stable orchestrator repair**  
**State:** `IN_PROGRESS / P0`
""",
            encoding="utf-8",
        )
        self._write_tasks(
            [
                {
                    "task_id": "JCC-004",
                    "project_id": "JCC",
                    "title": "Repair control plane",
                    "status": "IN_PROGRESS",
                    "priority": "P0",
                    "primary_wip": "true",
                    "blocked_by": "",
                    "user_action_required": "false",
                    "next_action": "Verify the next runtime readback",
                    "updated_at": "2026-08-14T18:00:00+03:00",
                },
                {
                    "task_id": "PRC-004",
                    "project_id": "PRC",
                    "title": "Approve payment rail later",
                    "status": "BLOCKED",
                    "priority": "P0",
                    "primary_wip": "false",
                    "blocked_by": "REAL_PAYER_REQUIRED",
                    "user_action_required": "true",
                    "next_action": "Activate only when a real payer requires it",
                    "updated_at": "2026-08-14T18:00:00+03:00",
                },
            ]
        )

        (self.root / "archive/results/records/RESULT-1.json").write_text(
            json.dumps(
                {
                    "result_id": "RESULT-1",
                    "task_id": "AUD-002",
                    "project_id": "AI_AUDIT",
                    "executor": "test",
                    "executor_type": "WORKFLOW",
                    "status": "SUCCEEDED",
                    "occurred_at": "2026-08-14T18:30:00+03:00",
                    "summary": "A bounded proof asset passed acceptance checks.",
                    "evidence": ["fixture evidence"],
                    "acceptance": {
                        "criterion": "bounded proof asset verified",
                        "outcome": "PASSED",
                    },
                    "closes_task": False,
                    "next_action": "Use only as technical proof until a buyer accepts it.",
                    "learning_candidate": False,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        self.policy = {
            "version": "2026-08-14.1",
            "logical_control_chat": "main",
            "timezone": "Europe/Kyiv",
            "report_label_local_time": "20:00",
            "source_requirements": {
                "snapshot_max_age_minutes": 90,
                "heartbeat_max_age_minutes": 90,
            },
            "delivery_boundary": {
                "automatic_chat_push_available": False,
                "automatic_google_drive_update_available": False,
                "guaranteed_delivery": "PRIVATE_DURABLE_REPORT_WITH_READBACK",
            },
        }
        self.now = datetime(2026, 8, 14, 17, 5, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_tasks(self, rows: list[dict[str, str]]) -> None:
        headers = [
            "task_id",
            "project_id",
            "title",
            "status",
            "priority",
            "primary_wip",
            "blocked_by",
            "user_action_required",
            "next_action",
            "updated_at",
        ]
        with (self.root / "registry/MASTER_TASK_REGISTRY.csv").open(
            "w", encoding="utf-8", newline=""
        ) as handle:
            writer = csv.DictWriter(handle, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)

    def _snapshot(self, generated: datetime | None = None) -> dict[str, object]:
        generated = generated or self.now
        return {
            "generated_utc": generated.isoformat(),
            "control_chat_authority": {
                "authority_version": "2026-08-14.1",
                "authority_sha256": AUTHORITY_SHA,
                "logical_name": "main",
                "status": "ACTIVE_CANONICAL",
                "binding": {"predecessor_role": "ARCHIVE_CONTEXT_ONLY"},
                "authority": {
                    "canonical_control_chat_count": 1,
                    "parallel_control_centers_forbidden": True,
                    "archive_chats_may_issue_system_changes": False,
                },
            },
            "top_dispatch": {
                "task_id": "JCC-004",
                "project_id": "JCC",
                "next_action": "Verify the next runtime readback",
            },
            "oversight": {
                "urgent_findings": [],
                "watchlist": [
                    {
                        "code": "STALE_ACTIVE_TASK",
                        "severity": "WARN",
                        "summary": "Task state is stale",
                        "task_ids": ["AUD-001"],
                    },
                    {
                        "code": "STALE_ACTIVE_TASK",
                        "severity": "WARN",
                        "summary": "Task state is stale",
                        "task_ids": ["DRS-001"],
                    },
                ],
            },
        }

    def _heartbeat(self, generated: datetime | None = None) -> dict[str, object]:
        generated = generated or self.now
        return {
            "generated_utc": generated.isoformat(),
            "status": "PASS",
            "control_plane_checks": [
                {"name": "validate_repo", "status": "PASS", "returncode": 0},
                {"name": "unit_regression", "status": "PASS", "returncode": 0},
            ],
        }

    def _report(
        self,
        *,
        snapshot: dict[str, object] | None = None,
        heartbeat: dict[str, object] | None = None,
    ) -> dict[str, object]:
        return _build_report(
            command_center=self.root,
            policy=self.policy,
            policy_sha=POLICY_SHA,
            snapshot=snapshot or self._snapshot(),
            heartbeat=heartbeat or self._heartbeat(),
            now=self.now,
            mode="dry-run",
        )

    def test_builds_five_section_report_bound_to_main(self) -> None:
        report = self._report()
        self.assertEqual(report["control_chat"]["logical_name"], "main")
        self.assertEqual(report["control_chat"]["authority_sha256"], AUTHORITY_SHA)
        self.assertEqual(
            set(report["sections"]),
            {
                "verified_work_completed",
                "decisions_taken",
                "blockers_and_risks",
                "next_system_actions",
                "user_action_marker",
            },
        )
        self.assertEqual(report["financial_result"]["amount"], 0)
        self.assertEqual(
            report["financial_result"]["status"],
            "ZERO_NO_CREDITED_SPENDABLE_EVIDENCE",
        )
        classes = {
            item["class"] for item in report["sections"]["verified_work_completed"]
        }
        self.assertIn("TECHNICAL_CONTROL", classes)
        self.assertIn("PROJECT_OR_BUSINESS", classes)
        self.assertFalse(report["sections"]["user_action_marker"]["required"])

    def test_stale_runtime_sources_are_explicit_blockers(self) -> None:
        old = self.now - timedelta(hours=3)
        report = self._report(
            snapshot=self._snapshot(old),
            heartbeat=self._heartbeat(old),
        )
        codes = {
            item["code"] for item in report["sections"]["blockers_and_risks"]
        }
        self.assertIn("STALE_RECOVERY_SNAPSHOT", codes)
        self.assertIn("RUNTIME_HEARTBEAT_NOT_FRESH_PASS", codes)
        self.assertFalse(report["source_freshness"]["snapshot"]["fresh"])
        self.assertFalse(report["source_freshness"]["heartbeat"]["fresh"])

    def test_user_action_requires_primary_blocked_active_gate(self) -> None:
        deferred = {
            "task_id": "PRC-004",
            "project_id": "PRC",
            "title": "Deferred payment rail",
            "status": "BLOCKED",
            "primary_wip": "false",
            "user_action_required": "true",
            "blocked_by": "REAL_PAYER_REQUIRED",
            "next_action": "Activate only when a real payer requires it",
        }
        active = dict(deferred)
        active.update(
            {
                "task_id": "PRC-005",
                "title": "Sign accepted payer document",
                "primary_wip": "true",
                "blocked_by": "USER_SIGNATURE_REQUIRED_NOW",
                "next_action": "Sign the already accepted payer document",
            }
        )
        self.assertEqual(_active_user_actions([deferred]), [])
        actions = _active_user_actions([deferred, active])
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["task_id"], "PRC-005")

    def test_markdown_is_mobile_first_without_table(self) -> None:
        markdown = _render_markdown(self._report())
        for heading in (
            "## 1. Що підтверджено зроблено",
            "## 2. Прийняті рішення",
            "## 3. Блокери та ризики",
            "## 4. Що система робить далі",
            "## 5. Чи потрібна дія користувача",
        ):
            self.assertIn(heading, markdown)
        self.assertFalse(any(line.lstrip().startswith("|") for line in markdown.splitlines()))
        self.assertIn("credited-spendable дохід:** **0**", markdown)


if __name__ == "__main__":
    unittest.main()
