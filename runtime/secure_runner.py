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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

RUNTIME_STATE_BRANCH = "jarvis-runtime-state"
HEARTBEAT_PATH = "runtime/public-runtime-heartbeat.json"


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


def _run(argv: tuple[str, ...], *, cwd: Path, env: dict[str, str]) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(
        list(argv),
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=600,
        check=False,
    )
    return {
        "status": "PASS" if completed.returncode == 0 else "FAIL",
        "returncode": completed.returncode,
        "duration_seconds": round(time.monotonic() - started, 3),
    }


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


def _queue_counts(queue_path: Path) -> dict[str, int]:
    if not queue_path.exists():
        return {"queue_total": 0, "selected_total": 0}
    payload = json.loads(queue_path.read_text(encoding="utf-8"))
    queue = payload.get("queue", []) if isinstance(payload, dict) else []
    selected = payload.get("strategic_selected", []) if isinstance(payload, dict) else []
    return {
        "queue_total": len(queue) if isinstance(queue, list) else 0,
        "selected_total": len(selected) if isinstance(selected, list) else 0,
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
            "User-Agent": "jarvis-public-runtime/1.0",
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


def persist_heartbeat(*, repo: str, token: str, heartbeat: dict[str, Any]) -> None:
    encoded_path = urllib.parse.quote(HEARTBEAT_PATH, safe="/")
    get_url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}?ref={urllib.parse.quote(RUNTIME_STATE_BRANCH)}"
    status, current = _request(get_url, token)
    sha = current.get("sha") if status == 200 and isinstance(current, dict) else None
    if status not in {200, 404}:
        raise RuntimeError(f"heartbeat readback failed with HTTP {status}")

    content = base64.b64encode(
        (json.dumps(heartbeat, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    ).decode("ascii")
    payload: dict[str, Any] = {
        "message": f"runtime heartbeat {heartbeat['generated_utc']}",
        "content": content,
        "branch": RUNTIME_STATE_BRANCH,
    }
    if isinstance(sha, str) and sha:
        payload["sha"] = sha

    put_url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
    put_status, _ = _request(put_url, token, method="PUT", payload=payload)
    if put_status not in {200, 201}:
        raise RuntimeError(f"heartbeat write failed with HTTP {put_status}")


def build_heartbeat(checks: list[dict[str, Any]], queue_counts: dict[str, int]) -> dict[str, Any]:
    passed = bool(checks) and all(item.get("status") == "PASS" for item in checks)
    return {
        "schema_version": 1,
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
        "local_project_executor_dispatch": "NOT_YET_ENABLED",
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

    checks: list[dict[str, Any]] = []
    for check in CHECKS:
        result = _run(check.argv, cwd=command_center, env=env)
        result["name"] = check.name
        checks.append(result)
        if result["status"] != "PASS":
            break

    queue_path = Path(args.workdir) / "queue.json"
    if all(item["status"] == "PASS" for item in checks):
        pipeline_results, queue_path = _run_queue_pipeline(
            command_center, env, Path(args.workdir)
        )
        checks.extend(pipeline_results)

    heartbeat = build_heartbeat(checks, _queue_counts(queue_path))
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
            },
            separators=(",", ":"),
        )
    )
    return 0 if heartbeat["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
