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
            "User-Agent": "jarvis-recovery-snapshot/1.0",
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


def _build_snapshot(queue_path: Path) -> dict[str, Any]:
    raw_bytes = queue_path.read_bytes()
    payload = json.loads(raw_bytes.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("queue payload must be an object")

    queue = payload.get("queue", [])
    if not isinstance(queue, list):
        queue = []
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

    return {
        "schema_version": 1,
        "generated_utc": utc_now(),
        "private_only": True,
        "source": "command-center-public-runtime",
        "queue_sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "chat_session_recovery": recovery,
        "top_dispatch": top_dispatch,
        "oversight": payload.get("oversight"),
        "runnable_count": payload.get("runnable_count"),
        "oversight_action_count": payload.get("oversight_action_count"),
        "recovery_contract": {
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
