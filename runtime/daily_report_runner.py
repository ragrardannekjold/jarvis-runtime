#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, time
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

RUNTIME_STATE_BRANCH = "jarvis-runtime-state"
HEARTBEAT_PATH = "runtime/public-runtime-heartbeat.json"
DEFAULT_WORKDIR = "/tmp/jarvis-daily-report"


def _request(
    url: str,
    token: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[int, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "jarvis-daily-report/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
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


def _read_private_json(*, repo: str, token: str, path: str) -> dict[str, Any] | None:
    encoded_path = urllib.parse.quote(path, safe="/")
    url = (
        f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
        f"?ref={urllib.parse.quote(RUNTIME_STATE_BRANCH)}"
    )
    status, current = _request(url, token)
    if status == 404:
        return None
    if status != 200 or not isinstance(current, dict):
        raise RuntimeError(f"private readback failed for {path} with HTTP {status}")
    content = current.get("content")
    if not isinstance(content, str) or current.get("encoding") != "base64":
        raise RuntimeError(f"private readback returned unsupported content for {path}")
    parsed = json.loads(base64.b64decode(content).decode("utf-8"))
    return parsed if isinstance(parsed, dict) else None


def _persist_private_text(
    *,
    repo: str,
    token: str,
    path: str,
    text: str,
    message: str,
) -> None:
    encoded_path = urllib.parse.quote(path, safe="/")
    get_url = (
        f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
        f"?ref={urllib.parse.quote(RUNTIME_STATE_BRANCH)}"
    )
    status, current = _request(get_url, token)
    sha = current.get("sha") if status == 200 and isinstance(current, dict) else None
    if status not in {200, 404}:
        raise RuntimeError(f"private readback failed for {path} with HTTP {status}")

    payload: dict[str, Any] = {
        "message": message,
        "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
        "branch": RUNTIME_STATE_BRANCH,
    }
    if isinstance(sha, str) and sha:
        payload["sha"] = sha
    put_url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
    put_status, _ = _request(put_url, token, method="PUT", payload=payload)
    if put_status not in {200, 201}:
        raise RuntimeError(f"private write failed for {path} with HTTP {put_status}")


def _load_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} root must be an object")
    return payload


def _reporting_policy(module_registry: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    reporting = module_registry.get("reporting")
    modules = module_registry.get("modules")
    if not isinstance(reporting, dict) or not isinstance(modules, list):
        raise ValueError("module registry reporting/modules contract missing")
    report_module = next(
        (
            item
            for item in modules
            if isinstance(item, dict) and item.get("module_id") == "daily-system-report"
        ),
        None,
    )
    if not isinstance(report_module, dict):
        raise ValueError("daily-system-report module missing")
    return reporting, report_module


def _parse_now(raw: str | None, timezone_name: str) -> datetime:
    if raw:
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            raise ValueError("--now must include timezone")
        return parsed.astimezone(ZoneInfo(timezone_name))
    return datetime.now(ZoneInfo(timezone_name))


def due_state(
    *,
    now: datetime,
    target_local_time: str,
    latest_report: dict[str, Any] | None,
) -> str:
    try:
        hour_raw, minute_raw = target_local_time.split(":", 1)
        target = time(hour=int(hour_raw), minute=int(minute_raw))
    except (ValueError, TypeError) as exc:
        raise ValueError("target_local_time must use HH:MM") from exc
    if latest_report and latest_report.get("local_date") == now.date().isoformat():
        return "ALREADY_PUBLISHED"
    if now.timetz().replace(tzinfo=None) < target:
        return "NOT_DUE"
    return "DUE"


def _run_report_builder(
    *,
    command_center: Path,
    queue_path: Path,
    heartbeat: dict[str, Any],
    now: datetime,
    workdir: Path,
) -> tuple[dict[str, Any], str]:
    workdir.mkdir(parents=True, exist_ok=True)
    heartbeat_path = workdir / "heartbeat.json"
    report_json_path = workdir / "report.json"
    report_markdown_path = workdir / "report.md"
    heartbeat_path.write_text(
        json.dumps(heartbeat, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    argv = [
        sys.executable,
        str(command_center / "scripts/build_daily_system_report.py"),
        "--module-registry",
        str(command_center / "config/module_registry.json"),
        "--queue-json",
        str(queue_path),
        "--heartbeat-json",
        str(heartbeat_path),
        "--checkpoint",
        str(command_center / "checkpoints/CURRENT_CHECKPOINT.md"),
        "--task-registry",
        str(command_center / "registry/MASTER_TASK_REGISTRY.csv"),
        "--stable-state",
        str(command_center / "config/stable_operating_state.json"),
        "--now",
        now.isoformat(),
        "--json-out",
        str(report_json_path),
        "--markdown-out",
        str(report_markdown_path),
    ]
    completed = subprocess.run(
        argv,
        cwd=command_center,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("private daily report builder failed")
    report = _load_object(report_json_path)
    markdown = report_markdown_path.read_text(encoding="utf-8")
    return report, markdown


def publish_if_due(
    *,
    command_center: Path,
    queue_path: Path,
    repo: str,
    token: str,
    now_raw: str | None = None,
    workdir: Path = Path(DEFAULT_WORKDIR),
) -> dict[str, Any]:
    module_registry = _load_object(command_center / "config/module_registry.json")
    reporting, report_module = _reporting_policy(module_registry)
    timezone_name = reporting.get("timezone")
    target_local_time = reporting.get("target_local_time")
    if not isinstance(timezone_name, str) or not isinstance(target_local_time, str):
        raise ValueError("reporting timezone/target missing")
    now = _parse_now(now_raw, timezone_name)

    latest_json_path = reporting.get("latest_json_path")
    latest_markdown_path = reporting.get("latest_markdown_path")
    archive_template = reporting.get("archive_markdown_path_template")
    if not all(
        isinstance(value, str) and value
        for value in (latest_json_path, latest_markdown_path, archive_template)
    ):
        raise ValueError("daily report output paths missing")
    if "{date}" not in archive_template:
        raise ValueError("daily report archive path must include {date}")

    if not (
        report_module.get("state") == "ENABLED"
        and report_module.get("auto_run") is True
        and report_module.get("safe_reversible") is True
    ):
        return {
            "status": "MODULE_NOT_ENABLED",
            "local_date": now.date().isoformat(),
        }

    latest = _read_private_json(
        repo=repo, token=token, path=str(latest_json_path)
    )
    state = due_state(
        now=now,
        target_local_time=target_local_time,
        latest_report=latest,
    )
    if state != "DUE":
        return {"status": state, "local_date": now.date().isoformat()}
    if not queue_path.is_file():
        raise RuntimeError("current queue snapshot is missing")

    heartbeat = _read_private_json(repo=repo, token=token, path=HEARTBEAT_PATH)
    if heartbeat is None:
        raise RuntimeError("current runtime heartbeat is missing")

    report, markdown = _run_report_builder(
        command_center=command_center,
        queue_path=queue_path,
        heartbeat=heartbeat,
        now=now,
        workdir=workdir,
    )
    expected_id = f"main-daily-{now.date().isoformat()}"
    if report.get("report_id") != expected_id or report.get("local_date") != now.date().isoformat():
        raise RuntimeError("daily report identity/date invariant failed")
    if report.get("control_surface") != "main":
        raise RuntimeError("daily report control surface invariant failed")

    archive_path = str(archive_template).format(date=now.date().isoformat())
    message_suffix = f"{expected_id} {now.isoformat()}"
    # Completion marker is written last. A partial write is retried on the next pulse.
    _persist_private_text(
        repo=repo,
        token=token,
        path=archive_path,
        text=markdown,
        message=f"archive daily system report {message_suffix}",
    )
    _persist_private_text(
        repo=repo,
        token=token,
        path=str(latest_markdown_path),
        text=markdown,
        message=f"update latest daily system report {message_suffix}",
    )
    _persist_private_text(
        repo=repo,
        token=token,
        path=str(latest_json_path),
        text=json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        message=f"complete daily system report {message_suffix}",
    )
    readback = _read_private_json(repo=repo, token=token, path=str(latest_json_path))
    if readback is None or readback.get("report_id") != expected_id:
        raise RuntimeError("daily report readback failed")
    return {
        "status": "PUBLISHED",
        "report_id": expected_id,
        "local_date": now.date().isoformat(),
        "latest_json_path": latest_json_path,
        "latest_markdown_path": latest_markdown_path,
        "archive_path": archive_path,
        "readback_verified": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--command-center", default=os.environ.get("COMMAND_CENTER_PATH", "command-center"))
    parser.add_argument("--queue", default="/tmp/jarvis-public-runtime/queue.json")
    parser.add_argument("--workdir", default=DEFAULT_WORKDIR)
    parser.add_argument("--now")
    args = parser.parse_args()

    repo = os.environ.get("COMMAND_CENTER_REPO", "").strip()
    token = os.environ.get("COMMAND_CENTER_TOKEN", "").strip()
    if not repo or not token:
        print('{"status":"REPORT_BRIDGE_NOT_CONFIGURED"}')
        return 2

    try:
        result = publish_if_due(
            command_center=Path(args.command_center).resolve(),
            queue_path=Path(args.queue).resolve(),
            repo=repo,
            token=token,
            now_raw=args.now,
            workdir=Path(args.workdir).resolve(),
        )
    except Exception:
        # Do not leak private report input/output to public logs.
        print('{"status":"DAILY_REPORT_FAILED"}')
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
