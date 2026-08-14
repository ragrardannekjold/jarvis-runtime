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
            "User-Agent": "jarvis-main-daily-report/2.0",
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


def _read_private_text(
    *,
    repo: str,
    token: str,
    branch: str,
    path: str,
) -> str | None:
    encoded_path = urllib.parse.quote(path, safe="/")
    url = (
        f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
        f"?ref={urllib.parse.quote(branch)}"
    )
    status, current = _request(url, token)
    if status == 404:
        return None
    if status != 200 or not isinstance(current, dict):
        raise RuntimeError(f"private readback failed for {path} with HTTP {status}")
    content = current.get("content")
    if not isinstance(content, str) or current.get("encoding") != "base64":
        raise RuntimeError(f"private readback returned unsupported content for {path}")
    return base64.b64decode(content).decode("utf-8")


def _read_private_json(
    *,
    repo: str,
    token: str,
    branch: str,
    path: str,
) -> dict[str, Any] | None:
    text = _read_private_text(repo=repo, token=token, branch=branch, path=path)
    if text is None:
        return None
    payload = json.loads(text)
    return payload if isinstance(payload, dict) else None


def _persist_private_text(
    *,
    repo: str,
    token: str,
    branch: str,
    path: str,
    text: str,
    message: str,
) -> None:
    encoded_path = urllib.parse.quote(path, safe="/")
    get_url = (
        f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
        f"?ref={urllib.parse.quote(branch)}"
    )
    status, current = _request(get_url, token)
    sha = current.get("sha") if status == 200 and isinstance(current, dict) else None
    if status not in {200, 404}:
        raise RuntimeError(f"private readback failed for {path} with HTTP {status}")

    payload: dict[str, Any] = {
        "message": message,
        "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
        "branch": branch,
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
    report_label_local_time: str,
    existing_report: dict[str, Any] | None,
    force: bool = False,
) -> str:
    hour_raw, minute_raw = report_label_local_time.split(":", 1)
    target = time(hour=int(hour_raw), minute=int(minute_raw))
    if existing_report and existing_report.get("local_date") == now.date().isoformat():
        return "FORCE_REBUILD" if force else "ALREADY_PUBLISHED"
    if now.timetz().replace(tzinfo=None) < target and not force:
        return "NOT_DUE"
    return "DUE"


def _module_enabled(module_registry: dict[str, Any], module_id: str) -> bool:
    modules = module_registry.get("modules")
    if not isinstance(modules, list):
        raise ValueError("module registry requires modules")
    module = next(
        (
            item
            for item in modules
            if isinstance(item, dict) and item.get("module_id") == module_id
        ),
        None,
    )
    if not isinstance(module, dict):
        raise ValueError(f"module missing: {module_id}")
    return (
        module.get("state") == "ENABLED"
        and module.get("auto_run") is True
        and module.get("readback_required") is True
        and module.get("idempotency_key_required") is True
    )


def _run_builder(
    *,
    command_center: Path,
    records_dir: Path,
    snapshot: dict[str, Any],
    heartbeat: dict[str, Any],
    now: datetime,
    workdir: Path,
) -> tuple[dict[str, Any], str]:
    workdir.mkdir(parents=True, exist_ok=True)
    snapshot_path = workdir / "recovery-snapshot.json"
    heartbeat_path = workdir / "heartbeat.json"
    report_json_path = workdir / "report.json"
    report_markdown_path = workdir / "report.md"
    snapshot_path.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    heartbeat_path.write_text(
        json.dumps(heartbeat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    argv = [
        sys.executable,
        str(command_center / "scripts/build_daily_control_report.py"),
        "--policy",
        str(command_center / "config/daily_control_report.json"),
        "--authority",
        str(command_center / "config/control_chat_authority.json"),
        "--module-registry",
        str(command_center / "config/module_registry.json"),
        "--recovery-snapshot",
        str(snapshot_path),
        "--heartbeat",
        str(heartbeat_path),
        "--checkpoint",
        str(command_center / "checkpoints/CURRENT_CHECKPOINT.md"),
        "--task-registry",
        str(command_center / "registry/MASTER_TASK_REGISTRY.csv"),
        "--records-dir",
        str(records_dir),
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
    records_dir: Path,
    repo: str,
    token: str,
    now_raw: str | None = None,
    force: bool = False,
    workdir: Path = Path(DEFAULT_WORKDIR),
) -> dict[str, Any]:
    policy = _load_object(command_center / "config/daily_control_report.json")
    module_registry = _load_object(command_center / "config/module_registry.json")
    if not _module_enabled(module_registry, "daily-system-report"):
        return {"status": "MODULE_NOT_ENABLED"}

    timezone_name = policy.get("timezone")
    report_label = policy.get("report_label_local_time")
    source_requirements = policy.get("source_requirements")
    durable_output = policy.get("durable_output")
    if not isinstance(timezone_name, str) or not isinstance(report_label, str):
        raise ValueError("daily report timezone/label missing")
    if not isinstance(source_requirements, dict) or not isinstance(durable_output, dict):
        raise ValueError("daily report source/output policy missing")
    now = _parse_now(now_raw, timezone_name)

    state_branch = durable_output.get("state_branch")
    daily_json_template = durable_output.get("daily_json_template")
    daily_markdown_template = durable_output.get("daily_markdown_template")
    current_markdown_path = durable_output.get("current_markdown_path")
    snapshot_path = source_requirements.get("control_authority")
    heartbeat_path = source_requirements.get("runtime_heartbeat")
    values = (
        state_branch,
        daily_json_template,
        daily_markdown_template,
        current_markdown_path,
        snapshot_path,
        heartbeat_path,
    )
    if not all(isinstance(value, str) and value for value in values):
        raise ValueError("daily report policy contains invalid paths")

    local_date = now.date().isoformat()
    daily_json_path = str(daily_json_template).format(local_date=local_date)
    daily_markdown_path = str(daily_markdown_template).format(local_date=local_date)
    existing = _read_private_json(
        repo=repo, token=token, branch=str(state_branch), path=daily_json_path
    )
    state = due_state(
        now=now,
        report_label_local_time=report_label,
        existing_report=existing,
        force=force,
    )
    if state not in {"DUE", "FORCE_REBUILD"}:
        return {"status": state, "local_date": local_date}

    snapshot = _read_private_json(
        repo=repo, token=token, branch=str(state_branch), path=str(snapshot_path)
    )
    heartbeat = _read_private_json(
        repo=repo, token=token, branch=str(state_branch), path=str(heartbeat_path)
    )
    if snapshot is None:
        raise RuntimeError("canonical main recovery snapshot is missing")
    if heartbeat is None:
        raise RuntimeError("runtime heartbeat is missing")
    if not records_dir.is_dir():
        raise RuntimeError("result ledger records directory is missing")

    report, markdown = _run_builder(
        command_center=command_center,
        records_dir=records_dir,
        snapshot=snapshot,
        heartbeat=heartbeat,
        now=now,
        workdir=workdir,
    )
    expected_id = f"main-20-00-{local_date}"
    if report.get("report_id") != expected_id or report.get("local_date") != local_date:
        raise RuntimeError("daily report identity/date invariant failed")
    if report.get("logical_control_chat") != "main":
        raise RuntimeError("daily report control authority invariant failed")

    suffix = f"{expected_id} {now.isoformat()}"
    # Completion JSON is written last. Partial writes remain retryable.
    _persist_private_text(
        repo=repo,
        token=token,
        branch=str(state_branch),
        path=daily_markdown_path,
        text=markdown,
        message=f"archive canonical daily report {suffix}",
    )
    _persist_private_text(
        repo=repo,
        token=token,
        branch=str(state_branch),
        path=str(current_markdown_path),
        text=markdown,
        message=f"update current canonical daily report {suffix}",
    )
    _persist_private_text(
        repo=repo,
        token=token,
        branch=str(state_branch),
        path=daily_json_path,
        text=json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        message=f"complete canonical daily report {suffix}",
    )
    readback = _read_private_json(
        repo=repo, token=token, branch=str(state_branch), path=daily_json_path
    )
    if readback is None or readback.get("report_id") != expected_id:
        raise RuntimeError("daily report readback failed")
    return {
        "status": "PUBLISHED",
        "report_id": expected_id,
        "local_date": local_date,
        "daily_json_path": daily_json_path,
        "daily_markdown_path": daily_markdown_path,
        "current_markdown_path": current_markdown_path,
        "readback_verified": True,
        "forced": force,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--command-center", default=os.environ.get("COMMAND_CENTER_PATH", "command-center")
    )
    parser.add_argument("--records-dir", default="results-state/archive/results/records")
    parser.add_argument("--workdir", default=DEFAULT_WORKDIR)
    parser.add_argument("--now")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    repo = os.environ.get("COMMAND_CENTER_REPO", "").strip()
    token = os.environ.get("COMMAND_CENTER_TOKEN", "").strip()
    if not repo or not token:
        print('{"status":"REPORT_BRIDGE_NOT_CONFIGURED"}')
        return 2

    try:
        result = publish_if_due(
            command_center=Path(args.command_center).resolve(),
            records_dir=Path(args.records_dir).resolve(),
            repo=repo,
            token=token,
            now_raw=args.now,
            force=args.force,
            workdir=Path(args.workdir).resolve(),
        )
    except Exception:
        # Private report content and paths are not printed on failure.
        print('{"status":"DAILY_REPORT_FAILED"}')
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
