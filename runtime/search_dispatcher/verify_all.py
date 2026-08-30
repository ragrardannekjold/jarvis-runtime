from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
COMPONENT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_behavior_tests() -> dict[str, object]:
    suite = unittest.defaultTestLoader.discover(str(COMPONENT / "tests"), pattern="test_*.py")
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    if result.testsRun != 13:
        raise RuntimeError(f"expected 13 behavioral tests, observed {result.testsRun}")
    if not result.wasSuccessful():
        raise RuntimeError("behavioral test gate failed")
    return {"tests_run": result.testsRun, "failures": 0, "errors": 0, "status": "PASS"}


def run_json_program(path: Path) -> dict[str, object]:
    completed = subprocess.run(
        [sys.executable, str(path)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
        env={"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8", "PYTHONPATH": str(ROOT)},
    )
    if completed.returncode != 0:
        raise RuntimeError(f"{path.name} failed")
    value = json.loads(completed.stdout)
    if not isinstance(value, dict):
        raise RuntimeError(f"{path.name} returned a non-object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Search Dispatcher v0.2 verification gate")
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        behavior = run_behavior_tests()
        syntax = subprocess.run(
            [os.environ.get("NODE", "node"), "--check", str(COMPONENT / "utility_search_executor.mjs")],
            cwd=ROOT,
            capture_output=True,
            timeout=30,
            check=False,
        )
        if syntax.returncode != 0:
            raise RuntimeError("Node executor syntax gate failed")
        smoke = run_json_program(COMPONENT / "smoke.py")
        if smoke.get("status") != "SMOKE_OK":
            raise RuntimeError("smoke marker missing")
        restart = run_json_program(COMPONENT / "restart_canary.py")
        if restart.get("status") != "RESTART_CANARY_OK" or restart.get("attempt_count") != 1:
            raise RuntimeError("restart canary marker missing")
        source_paths = [
            COMPONENT / "dispatcher.py",
            COMPONENT / "utility_search_executor.mjs",
            COMPONENT / "config.v0.2.json",
            COMPONENT / "fallback-catalog.v0.2.json",
            COMPONENT / "tests" / "test_dispatcher.py",
            COMPONENT / "smoke.py",
            COMPONENT / "restart_canary.py",
            ROOT / "ci" / "ai49_core" / "jarvis" / "truth_guard.py",
            ROOT / "plugin" / "utility-search" / "lib" / "catalog.js",
        ]
        manifest = {str(path.relative_to(ROOT)): sha256_file(path) for path in source_paths}
        receipt = {
            "schema_version": 2,
            "component": "Search Dispatcher v0.2",
            "status": "VERIFIED_BUILD",
            "scope": "local_process_restart",
            "control_plane_persistent": False,
            "production_active": False,
            "private_work_admission": False,
            "verified_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "behavioral_tests": behavior,
            "smoke": smoke,
            "restart_canary": restart,
            "source_manifest": manifest,
            "source_manifest_sha256": hashlib.sha256(
                json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
            "certification_rule": "CONTROL_PLANE_PERSISTENT requires remote durable backend readback after a fresh runtime restart",
        }
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.receipt.with_suffix(f"{args.receipt.suffix}.tmp")
        temporary.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary, args.receipt)
        print(json.dumps({
            "status": receipt["status"],
            "scope": receipt["scope"],
            "behavioral_tests": 13,
            "smoke": "PASS",
            "restart_canary": "PASS",
            "receipt": str(args.receipt),
        }, sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"status": "CONTROL_PLANE_NOT_PERSISTENT", "error_code": type(error).__name__}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
