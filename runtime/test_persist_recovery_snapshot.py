from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from persist_recovery_snapshot import _build_snapshot


AUTHORITY_SHA = "a" * 64


def valid_payload() -> dict[str, object]:
    return {
        "chat_session_recovery": {
            "failure_events": ["MESSAGE_STREAM_ERROR"],
            "rules": {
                "recovery_decision_is_system_owned": True,
                "stream_error_is_transport_event_not_job_failure": True,
                "stream_error_requires_automatic_restore_and_resume": True,
            },
        },
        "control_chat_authority": {
            "authority_version": "2026-08-14.1",
            "authority_sha256": AUTHORITY_SHA,
            "logical_name": "main",
            "status": "ACTIVE_CANONICAL",
            "binding": {
                "predecessor_role": "ARCHIVE_CONTEXT_ONLY",
            },
            "authority": {
                "canonical_control_chat_count": 1,
                "parallel_control_centers_forbidden": True,
                "archive_chats_may_issue_system_changes": False,
                "old_next_actions_require_revalidation": True,
                "system_wide_change_requires_readback": True,
            },
        },
        "queue": [
            {
                "task_id": "JCC-004",
                "project_id": "JCC",
                "required_control_chat_authority_sha256": AUTHORITY_SHA,
            }
        ],
        "oversight": {"critical_count": 0},
        "runnable_count": 1,
        "oversight_action_count": 0,
    }


class RecoverySnapshotAuthorityTests(unittest.TestCase):
    def _write(self, payload: dict[str, object]) -> Path:
        handle = tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".json", delete=False
        )
        with handle:
            json.dump(payload, handle)
        return Path(handle.name)

    def test_snapshot_persists_single_main_authority(self) -> None:
        snapshot = _build_snapshot(self._write(valid_payload()))
        self.assertEqual(snapshot["schema_version"], 2)
        self.assertEqual(snapshot["control_chat_authority"]["logical_name"], "main")
        self.assertTrue(snapshot["recovery_contract"]["single_main_control_authority"])
        self.assertTrue(snapshot["recovery_contract"]["predecessor_chat_is_archive_context_only"])

    def test_rejects_missing_authority(self) -> None:
        payload = valid_payload()
        payload.pop("control_chat_authority")
        with self.assertRaisesRegex(ValueError, "missing control_chat_authority"):
            _build_snapshot(self._write(payload))

    def test_rejects_split_authority(self) -> None:
        payload = copy.deepcopy(valid_payload())
        payload["control_chat_authority"]["authority"]["canonical_control_chat_count"] = 2
        with self.assertRaisesRegex(ValueError, "exactly one"):
            _build_snapshot(self._write(payload))

    def test_rejects_dispatch_not_bound_to_authority_sha(self) -> None:
        payload = copy.deepcopy(valid_payload())
        payload["queue"][0]["required_control_chat_authority_sha256"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "not bound"):
            _build_snapshot(self._write(payload))


if __name__ == "__main__":
    unittest.main()
