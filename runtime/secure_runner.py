#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

RUNTIME_STATE_BRANCH = "jarvis-runtime-state"
HEARTBEAT_PATH = "runtime/public-runtime-heartbeat.json"
LOCAL_EXECUTOR_REGISTRY = "config/public_runtime_executors.json"
EXECUTOR_RESULT_DIR = "runtime/executor-results"


@dataclass(frozen=True)
class Check:
    name: str
    argv: tuple[str, ...]


CHECKS: tuple[Check, ...] = (
    Check("validate_repo", ("python", "scripts/validate_repo.py")),
    Check("validate_strategic_priority", ("python", "scripts/validate_strategic_priority.py")),
    Check("unit_regression", ("python", "-m", "unittest", "discover", "-s", "tests", "-q")),
    Check("validate_project_isolation", ("python", "scripts/validate_project_isolation.py")),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _run(
    argv: tuple[str, ...],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout_seconds: int = 600,
    retain_output: bool = False,
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            list(argv),
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        result: dict[str, Any] = {
            "status": "PASS" if completed.returncode == 0 else "FAIL",
            "returncode": completed.returncode,
            "duration_seconds": round(time.monotonic() - started, 3),
        }
        if retain_output:
            result["stdout"] = completed.stdout
            result["stderr"] = completed.stderr
        return result
    except subprocess.TimeoutExpired as exc:
        result = {
            "status": "TIMEOUT",
            "returncode": -1,
            "duration_seconds": round(time.monotonic() - started, 3),
        }
        if retain_output:
            result["stdout"] = exc.stdout if isinstance(exc.stdout, str) else ""
            result["stderr"] = exc.stderr if isinstance(exc.stderr, str) else ""
        return result


def _run_queue_pipeline(command_center: Path, env: dict[str, str], workdir: Path) -> tuple[list[dict[str, Any]], Path]:
    workdir.mkdir(parents=True, exist_ok=True)
    queue_path = workdir / "queue.json"
    steps = (
        ("build_queue", ("python", "scripts/orchestrator_controller.py", "--limit", "1000", "--json-out", str(queue_path))),
        ("attach_project_contracts", ("python", "scripts/attach_project_contracts.py", "--queue-json", str(queue_path))),
        ("attach_learning_review", ("python", "scripts/attach_learning_review.py", "--queue-json", str(queue_path))),
        ("apply_strategic_priority", ("python", "scripts/apply_strategic_priority.py", "--queue-json", str(queue_path), "--limit", "10")),
        ("attach_interactive_quality_guard", ("python", "scripts/attach_interactive_quality_guard.py", "--queue-json", str(queue_path))),
    )
    results: list[dict[str, Any]] = []
    for name, argv in steps:
        result = _run(argv, cwd=command_center, env=env)
        result["name"] = name
        results.append(result)
        if result["status"] != "PASS":
            break
    return results, queue_path


def _queue_payload(queue_path: Path) -> dict[str, Any]:
    if not queue_path.exists():
        return {}
    payload = json.loads(queue_path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def _queue_counts(queue_path: Path) -> dict[str, int]:
    payload = _queue_payload(queue_path)
    queue = payload.get("queue", [])
    if not isinstance(queue, list):
        queue = []
    before_limit = payload.get("runnable_count_before_strategic_limit", len(queue))
    if not isinstance(before_limit, int) or before_limit < 0:
        before_limit = len(queue)
    return {
        "queue_total": len(queue),
        "selected_total": len(queue),
        "runnable_before_strategic_limit": before_limit,
    }


def _request(url: str, token: str, method: str = "GET", payload: dict[str, Any] | None = None) -> tuple[int, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "jarvis-public-runtime/1.1",
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


def _read_private_json(*, repo: str, token: str, path: str) -> dict[str, Any] | None:
    encoded_path = urllib.parse.quote(path, safe="/")
    url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}?ref={urllib.parse.quote(RUNTIME_STATE_BRANCH)}"
    status, current = _request(url, token)
    if status == 404:
        return None
    if status != 200 or not isinstance(current, dict):
        raise RuntimeError(f"private readback failed for {path} with HTTP {status}")
    content = current.get("content")
    encoding = current.get("encoding")
    if not isinstance(content, str) or encoding != "base64":
        raise RuntimeError(f"private readback returned unsupported content for {path}")
    raw = base64.b64decode(content).decode("utf-8")
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, dict) else None


def _persist_private_json(*, repo: str, token: str, path: str, payload_obj: dict[str, Any], message: str) -> None:
    encoded_path = urllib.parse.quote(path, safe="/")
    get_url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}?ref={urllib.parse.quote(RUNTIME_STATE_BRANCH)}"
    status, current = _request(get_url, token)
    sha = current.get("sha") if status == 200 and isinstance(current, dict) else None
    if status not in {200, 404}:
        raise RuntimeError(f"private readback failed for {path} with HTTP {status}")

    content = base64.b64encode(
        (json.dumps(payload_obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    ).decode("ascii")
    request_payload: dict[str, Any] = {
        "message": message,
        "content": content,
        "branch": RUNTIME_STATE_BRANCH,
    }
    if isinstance(sha, str) and sha:
        request_payload["sha"] = sha

    put_url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
    put_status, _ = _request(put_url, token, method="PUT", payload=request_payload)
    if put_status not in {200, 201}:
        raise RuntimeError(f"private write failed for {path} with HTTP {put_status}")


def persist_heartbeat(*, repo: str, token: str, heartbeat: dict[str, Any]) -> None:
    _persist_private_json(
        repo=repo,
        token=token,
        path=HEARTBEAT_PATH,
        payload_obj=heartbeat,
        message=f"runtime heartbeat {heartbeat['generated_utc']}",
    )


def _previous_executor_times(previous_heartbeat: dict[str, Any] | None) -> dict[str, datetime]:
    result: dict[str, datetime] = {}
    if not isinstance(previous_heartbeat, dict):
        return result
    entries = previous_heartbeat.get("executor_results", [])
    if not isinstance(entries, list):
        return result
    for item in entries:
        if not isinstance(item, dict):
            continue
        executor_id = item.get("executor_id")
        when = _parse_iso(item.get("completed_utc"))
        if isinstance(executor_id, str) and when is not None:
            result[executor_id] = when
    return result


def run_local_executors(
    *,
    command_center: Path,
    queue_path: Path,
    env: dict[str, str],
    repo: str,
    token: str,
    previous_heartbeat: dict[str, Any] | None,
) -> tuple[str, list[dict[str, Any]]]:
    registry_path = command_center / LOCAL_EXECUTOR_REGISTRY
    if not registry_path.exists():
        return "NOT_CONFIGURED", []
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    if not isinstance(registry, dict):
        raise RuntimeError("local executor registry root must be an object")
    executors = registry.get("executors", [])
    if not isinstance(executors, list):
        raise RuntimeError("local executor registry requires executors list")
    max_executors = registry.get("max_executors_per_cycle", 1)
    if not isinstance(max_executors, int) or max_executors < 1 or max_executors > 5:
        raise RuntimeError("max_executors_per_cycle must be between 1 and 5")

    queue = _queue_payload(queue_path).get("queue", [])
    if not isinstance(queue, list):
        queue = []
    selected = {
        (str(item.get("project_id", "")), str(item.get("task_id", "")))
        for item in queue
        if isinstance(item, dict)
    }
    previous_times = _previous_executor_times(previous_heartbeat)
    now = datetime.now(timezone.utc)
    summaries: list[dict[str, Any]] = []
    attempted = 0

    for spec in executors:
        if attempted >= max_executors:
            break
        if not isinstance(spec, dict):
            continue
        executor_id = str(spec.get("executor_id", "")).strip()
        project_id = str(spec.get("project_id", "")).strip()
        task_id = str(spec.get("task_id", "")).strip()
        if not executor_id or not project_id or not task_id:
            continue
        if (project_id, task_id) not in selected:
            continue
        if spec.get("auto_run") is not True or spec.get("safe_reversible") is not True:
            summaries.append(
                {
                    "executor_id": executor_id,
                    "project_id": project_id,
                    "task_id": task_id,
                    "status": "BLOCKED",
                    "reason": "NOT_EXPLICITLY_AUTHORIZED_SAFE_REVERSIBLE",
                    "completed_utc": utc_now(),
                }
            )
            continue

        cooldown_minutes = spec.get("cooldown_minutes", 60)
        if not isinstance(cooldown_minutes, int) or cooldown_minutes < 0:
            cooldown_minutes = 60
        previous = previous_times.get(executor_id)
        if previous is not None and now - previous < timedelta(minutes=cooldown_minutes):
            summaries.append(
                {
                    "executor_id": executor_id,
                    "project_id": project_id,
                    "task_id": task_id,
                    "status": "SKIP",
                    "reason": "COOLDOWN",
                    "previous_run_utc": previous.isoformat(),
                    "completed_utc": utc_now(),
                }
            )
            continue

        command_raw = spec.get("command")
        if not isinstance(command_raw, list) or not command_raw or not all(isinstance(part, str) and part for part in command_raw):
            summaries.append(
                {
                    "executor_id": executor_id,
                    "project_id": project_id,
                    "task_id": task_id,
                    "status": "BLOCKED",
                    "reason": "INVALID_COMMAND_ALLOWLIST_ENTRY",
                    "completed_utc": utc_now(),
                }
            )
            continue
        timeout_seconds = spec.get("timeout_seconds", 300)
        if not isinstance(timeout_seconds, int) or timeout_seconds < 1 or timeout_seconds > 1200:
            timeout_seconds = 300

        attempted += 1
        result = _run(
            tuple(command_raw),
            cwd=command_center,
            env=env,
            timeout_seconds=timeout_seconds,
            retain_output=True,
        )
        completed_utc = utc_now()
        private_result_path = f"{EXECUTOR_RESULT_DIR}/{executor_id}-latest.json"
        private_result = {
            "schema_version": 1,
            "executor_id": executor_id,
            "project_id": project_id,
            "task_id": task_id,
            "completed_utc": completed_utc,
            "status": result.get("status"),
            "returncode": result.get("returncode"),
            "duration_seconds": result.get("duration_seconds"),
            "stdout": result.get("stdout", "") if spec.get("persist_stdout_private") is True else "",
            "stderr": result.get("stderr", ""),
            "private_only": True,
        }
        _persist_private_json(
            repo=repo,
            token=token,
            path=private_result_path,
            payload_obj=private_result,
            message=f"runtime executor {executor_id} {completed_utc}",
        )
        summaries.append(
            {
                "executor_id": executor_id,
                "project_id": project_id,
                "task_id": task_id,
                "status": str(result.get("status", "FAIL")),
                "returncode": int(result.get("returncode", -1)),
                "duration_seconds": result.get("duration_seconds"),
                "completed_utc": completed_utc,
                "private_result_path": private_result_path,
            }
        )

    if attempted == 0:
        return "ENABLED_NO_EXECUTION", summaries
    if any(item.get("status") not in {"PASS", "SKIP"} for item in summaries):
        return "ENABLED_WITH_FAILURE", summaries
    return "ENABLED_EXECUTED", summaries


def build_heartbeat(
    checks: list[dict[str, Any]],
    queue_counts: dict[str, int],
    *,
    local_dispatch_state: str = "NOT_YET_ENABLED",
    executor_results: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    passed = bool(checks) and all(item.get("status") == "PASS" for item in checks)
    return {
        "schema_version": 2,
        "generated_utc": utc_now(),
        "status": "PASS" if passed else "FAIL",
        "runtime": "github_public_hosted_runner",
        "control_plane_checks": [
            {
                "name": str(item.get("name", "unknown")),
                "status": str(item.get("status", "FAIL")),
                "returncode": int(item.get("returncode", -1)),
            }
            for item in checks
        ],
        **queue_counts,
        "private_data_exposed_to_public_artifacts": False,
        "private_output_logged": False,
        "local_project_executor_dispatch": local_dispatch_state,
        "executor_results": list(executor_results or []),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--command-center", default=os.environ.get("COMMAND_CENTER_PATH", "command-center"))
    parser.add_argument("--workdir", default="/tmp/jarvis-public-runtime")
    args = parser.parse_args()

    repo = os.environ.get("COMMAND_CENTER_REPO", "").strip()
    token = os.environ.get("COMMAND_CENTER_TOKEN", "").strip()
    if not repo or not token:
        print("PUBLIC_RUNTIME_BRIDGE_NOT_CONFIGURED")
        return 2

    command_center = Path(args.command_center).resolve()
    if not (command_center / "scripts").is_dir() or not (command_center / "src").is_dir():
        print("PRIVATE_CHECKOUT_INVALID")
        return 3

    env = dict(os.environ)
    env["PYTHONPATH"] = str(command_center / "src")
    env.pop("COMMAND_CENTER_TOKEN", None)
    env.pop("COMMAND_CENTER_REPO", None)

    try:
        previous_heartbeat = _read_private_json(repo=repo, token=token, path=HEARTBEAT_PATH)
    except Exception:
        previous_heartbeat = None

    checks: list[dict[str, Any]] = []
    for check in CHECKS:
        result = _run(check.argv, cwd=command_center, env=env)
        result["name"] = check.name
        checks.append(result)
        if result["status"] != "PASS":
            break

    queue_path = Path(args.workdir) / "queue.json"
    local_dispatch_state = "NOT_RUN_CONTROL_CHECK_FAILURE"
    executor_results: list[dict[str, Any]] = []
    if all(item["status"] == "PASS" for item in checks):
        pipeline_results, queue_path = _run_queue_pipeline(command_center, env, Path(args.workdir))
        checks.extend(pipeline_results)
        if all(item["status"] == "PASS" for item in checks):
            try:
                local_dispatch_state, executor_results = run_local_executors(
                    command_center=command_center,
                    queue_path=queue_path,
                    env=env,
                    repo=repo,
                    token=token,
                    previous_heartbeat=previous_heartbeat,
                )
            except Exception:
                local_dispatch_state = "ENABLED_RUNTIME_ERROR"
                executor_results = [
                    {
                        "executor_id": "runtime-dispatch",
                        "project_id": "JCC",
                        "task_id": "JCC-004",
                        "status": "FAIL",
                        "reason": "LOCAL_EXECUTOR_RUNTIME_ERROR",
                        "completed_utc": utc_now(),
                    }
                ]

    heartbeat = build_heartbeat(
        checks,
        _queue_counts(queue_path),
        local_dispatch_state=local_dispatch_state,
        executor_results=executor_results,
    )
    try:
        persist_heartbeat(repo=repo, token=token, heartbeat=heartbeat)
    except Exception:
        print("HEARTBEAT_PERSIST_FAILED")
        return 4

    print(
        json.dumps(
            {
                "status": heartbeat["status"],
                "checks_passed": sum(1 for item in checks if item.get("status") == "PASS"),
                "checks_total": len(checks),
                "queue_total": heartbeat["queue_total"],
                "selected_total": heartbeat["selected_total"],
                "local_project_executor_dispatch": heartbeat["local_project_executor_dispatch"],
                "executor_results_count": len(heartbeat["executor_results"]),
            },
            separators=(",", ":"),
        )
    )
    return 0 if heartbeat["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
