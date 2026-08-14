#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_BRANCH = "jarvis-runtime-state"
SNAPSHOT_PATH = "runtime/chat-recovery/latest.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _request(
    url: str,
    token: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[int, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "jarvis-recovery-snapshot/1.1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            parsed = json.loads(raw.decode("utf-8")) if raw else None
            return response.status, parsed
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except Exception:
            parsed = None
        return exc.code, parsed


def _validated_control_authority(
    payload: dict[str, Any], queue: list[object]
) -> dict[str, Any]:
    control = payload.get("control_chat_authority")
    if not isinstance(control, dict):
        raise ValueError("queue payload missing control_chat_authority")
    if control.get("logical_name") != "main":
        raise ValueError("canonical control chat logical_name must remain main")
    if control.get("status") != "ACTIVE_CANONICAL":
        raise ValueError("canonical main authority must remain ACTIVE_CANONICAL")

    authority = control.get("authority")
    if not isinstance(authority, dict):
        raise ValueError("control_chat_authority missing authority rules")
    if authority.get("canonical_control_chat_count") != 1:
        raise ValueError("exactly one canonical main control chat is required")
    if authority.get("parallel_control_centers_forbidden") is not True:
        raise ValueError("parallel control centers must remain forbidden")
    if authority.get("archive_chats_may_issue_system_changes") is not False:
        raise ValueError("archive chats must not issue system-wide changes")
    if authority.get("old_next_actions_require_revalidation") is not True:
        raise ValueError("archive next actions must require revalidation")
    if authority.get("system_wide_change_requires_readback") is not True:
        raise ValueError("system-wide changes must require readback")

    binding = control.get("binding")
    if not isinstance(binding, dict) or binding.get("predecessor_role") != "ARCHIVE_CONTEXT_ONLY":
        raise ValueError("predecessor control chat must remain ARCHIVE_CONTEXT_ONLY")

    authority_sha = control.get("authority_sha256")
    if not isinstance(authority_sha, str) or len(authority_sha) != 64:
        raise ValueError("control chat authority requires SHA-256 binding")
    for index, item in enumerate(queue):
        if not isinstance(item, dict):
            raise ValueError(f"queue item {index} must be an object")
        if item.get("required_control_chat_authority_sha256") != authority_sha:
            raise ValueError(f"queue item {index} is not bound to canonical main authority")

    return control


def _build_snapshot(queue_path: Path) -> dict[str, Any]:
    raw_bytes = queue_path.read_bytes()
    payload = json.loads(raw_bytes.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("queue payload must be an object")

    queue = payload.get("queue", [])
    if not isinstance(queue, list):
        raise ValueError("queue payload requires queue list")
    top_dispatch = queue[0] if queue and isinstance(queue[0], dict) else None

    recovery = payload.get("chat_session_recovery")
    if not isinstance(recovery, dict):
        raise ValueError("queue payload missing chat_session_recovery")
    failure_events = recovery.get("failure_events", [])
    rules = recovery.get("rules", {})
    if "MESSAGE_STREAM_ERROR" not in failure_events:
        raise ValueError("message-stream recovery event is not enforced")
    if not isinstance(rules, dict) or rules.get("recovery_decision_is_system_owned") is not True:
        raise ValueError("system-owned recovery rule is not enforced")
    if rules.get("stream_error_is_transport_event_not_job_failure") is not True:
        raise ValueError("stream errors are not classified as transport events")
    if rules.get("stream_error_requires_automatic_restore_and_resume") is not True:
        raise ValueError("automatic restore/resume rule is not enforced")

    control_authority = _validated_control_authority(payload, queue)

    return {
        "schema_version": 2,
        "generated_utc": utc_now(),
        "private_only": True,
        "source": "command-center-public-runtime",
        "queue_sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "control_chat_authority": control_authority,
        "chat_session_recovery": recovery,
        "top_dispatch": top_dispatch,
        "oversight": payload.get("oversight"),
        "runnable_count": payload.get("runnable_count"),
        "oversight_action_count": payload.get("oversight_action_count"),
        "recovery_contract": {
            "single_main_control_authority": True,
            "parallel_control_centers_forbidden": True,
            "predecessor_chat_is_archive_context_only": True,
            "archive_next_actions_require_revalidation": True,
            "system_wide_change_requires_durable_readback": True,
            "message_stream_error_is_transport_event": True,
            "job_failure_from_stream_disconnect_forbidden": True,
            "automatic_restore_and_resume": True,
            "ask_user_to_repeat_known_context": False,
            "ask_user_to_choose_recovery_behavior": False,
            "unknown_external_side_effect_requires_readback": True,
        },
    }


def _persist(*, repo: str, token: str, snapshot: dict[str, Any]) -> None:
    encoded_path = urllib.parse.quote(SNAPSHOT_PATH, safe="/")
    read_url = (
        f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
        f"?ref={urllib.parse.quote(STATE_BRANCH)}"
    )
    status, current = _request(read_url, token)
    sha = current.get("sha") if status == 200 and isinstance(current, dict) else None
    if status not in {200, 404}:
        raise RuntimeError(f"snapshot readback failed with HTTP {status}")

    encoded = base64.b64encode(
        (json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    ).decode("ascii")
    body: dict[str, Any] = {
        "message": f"chat recovery snapshot {snapshot['generated_utc']}",
        "content": encoded,
        "branch": STATE_BRANCH,
    }
    if isinstance(sha, str) and sha:
        body["sha"] = sha

    write_url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
    write_status, _ = _request(write_url, token, method="PUT", payload=body)
    if write_status not in {200, 201}:
        raise RuntimeError(f"snapshot persist failed with HTTP {write_status}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", default="/tmp/jarvis-public-runtime/queue.json")
    args = parser.parse_args()

    repo = os.environ.get("COMMAND_CENTER_REPO", "").strip()
    token = os.environ.get("COMMAND_CENTER_TOKEN", "").strip()
    if not repo or not token:
        print("RECOVERY_SNAPSHOT_BRIDGE_NOT_CONFIGURED")
        return 2

    queue_path = Path(args.queue)
    if not queue_path.is_file():
        print("RECOVERY_SNAPSHOT_QUEUE_MISSING")
        return 3

    try:
        snapshot = _build_snapshot(queue_path)
        _persist(repo=repo, token=token, snapshot=snapshot)
    except Exception as exc:
        print(f"RECOVERY_SNAPSHOT_FAILED:{type(exc).__name__}")
        return 4

    print("RECOVERY_SNAPSHOT_PERSISTED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
