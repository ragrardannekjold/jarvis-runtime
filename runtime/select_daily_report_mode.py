#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

VALID_MODES = {"dry-run", "verification", "final"}
DEFAULT_VERIFICATION_MARKER = "[main-daily-report:verification]"
DEFAULT_VERIFICATION_TRIGGER = "runtime/daily-report-verify-trigger.txt"


class ModeSelectionError(ValueError):
    pass


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def push_changed_files(payload: dict[str, Any]) -> tuple[str, ...]:
    head = payload.get("head_commit")
    if not isinstance(head, dict):
        return ()
    files: list[str] = []
    for key in ("added", "modified", "removed"):
        files.extend(_string_list(head.get(key)))
    return tuple(dict.fromkeys(files))


def push_commit_message(payload: dict[str, Any]) -> str:
    head = payload.get("head_commit")
    if not isinstance(head, dict):
        return ""
    message = head.get("message")
    return message if isinstance(message, str) else ""


def select_mode(
    *,
    event_name: str,
    payload: dict[str, Any] | None = None,
    dispatch_mode: str = "",
    verification_marker: str = DEFAULT_VERIFICATION_MARKER,
    verification_trigger: str = DEFAULT_VERIFICATION_TRIGGER,
    changed_files: Iterable[str] | None = None,
    commit_message: str | None = None,
) -> str:
    payload = payload or {}
    event_name = event_name.strip()

    if event_name == "schedule":
        return "final"

    if event_name == "workflow_dispatch":
        candidate = dispatch_mode.strip()
        if not candidate:
            inputs = payload.get("inputs")
            if isinstance(inputs, dict) and isinstance(inputs.get("mode"), str):
                candidate = inputs["mode"].strip()
        if candidate not in VALID_MODES:
            raise ModeSelectionError(
                f"workflow_dispatch mode must be one of {sorted(VALID_MODES)}, got {candidate!r}"
            )
        return candidate

    if event_name == "push":
        message = commit_message if commit_message is not None else push_commit_message(payload)
        files = tuple(changed_files) if changed_files is not None else push_changed_files(payload)
        if verification_marker and verification_marker in message:
            return "verification"
        if verification_trigger in files:
            return "verification"
        return "dry-run"

    if event_name in {"pull_request", "pull_request_target"}:
        return "dry-run"

    return "dry-run"


def load_event(path: str | Path) -> dict[str, Any]:
    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ModeSelectionError(f"cannot read GitHub event payload: {exc}") from exc
    if not isinstance(payload, dict):
        raise ModeSelectionError("GitHub event payload must be a JSON object")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-name", required=True)
    parser.add_argument("--event-json", required=True)
    parser.add_argument("--dispatch-mode", default="")
    args = parser.parse_args()

    try:
        payload = load_event(args.event_json)
        mode = select_mode(
            event_name=args.event_name,
            payload=payload,
            dispatch_mode=args.dispatch_mode,
        )
    except ModeSelectionError as exc:
        print(f"DAILY_REPORT_MODE_SELECTION_FAILED:{exc}")
        return 2

    print(mode)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
