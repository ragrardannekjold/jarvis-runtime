from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from runtime.search_dispatcher import SearchDispatcher, canonical_hash


class FixedClock:
    def __init__(self, value: float):
        self.value = value

    def __call__(self) -> float:
        return self.value


def request(intent_id: str, *, priority: int) -> dict[str, object]:
    return {
        "schema_version": 2,
        "intent_id": intent_id,
        "capability": "utility.catalog.search",
        "query": "github repository",
        "limit": 3,
        "priority": priority,
        "lane": "background",
        "correlation": {
            "mission_id": "CODE-P0-01",
            "route_id": "restart-canary",
            "cell_id": intent_id,
        },
    }


def phase(db_path: Path, name: str) -> dict[str, object]:
    phase_time = {
        "seed": 1_000.0,
        "recover": 2_000.0,
        "execute": 2_001.0,
        "verify": 2_002.0,
        "readback": 2_003.0,
    }[name]
    dispatcher = SearchDispatcher(db_path, clock=FixedClock(phase_time))
    pid = os.getpid()
    if name == "seed":
        canary = dispatcher.submit(request("restart-canary-v0.2", priority=100))
        sentinel_a = dispatcher.submit(request("restart-sentinel-a", priority=1))
        sentinel_b = dispatcher.submit(request("restart-sentinel-b", priority=0))
        claim = dispatcher.claim_next(f"canary-seed-{pid}")
        if claim is None or claim.job_id != canary["job_id"]:
            raise RuntimeError("canary was not durably claimed")
        dispatcher.mark_running(claim)
        return {
            "phase": name,
            "pid": pid,
            "job_id": canary["job_id"],
            "claim_id": claim.claim_id,
            "effect_key": claim.effect_key,
            "sentinels": [sentinel_a["job_id"], sentinel_b["job_id"]],
        }
    if name == "recover":
        recovered = dispatcher.recover_expired()
        if recovered != {"recovered": 1, "blocked": 0}:
            raise RuntimeError("expired pre-effect lease was not recovered exactly once")
        dispatcher.checkpoint()
        return {"phase": name, "pid": pid, **recovered}
    if name == "execute":
        result = dispatcher.run_one(f"canary-execute-{pid}", verify=False)
        if result.get("state") != "RESULT_RECORDED" or result.get("done") is not False:
            raise RuntimeError("executor phase did not stop at durable result")
        return {"phase": name, "pid": pid, "job_id": result["job_id"], "state": result["state"]}
    if name == "verify":
        result = dispatcher.run_one(f"canary-verify-{pid}")
        if result.get("state") != "VERIFIED" or result.get("done") is not True:
            raise RuntimeError("fresh verifier did not promote terminal truth")
        dispatcher.checkpoint()
        return {"phase": name, "pid": pid, "job_id": result["job_id"], "receipt_sha256": result["receipt_sha256"]}

    duplicate = dispatcher.submit(request("restart-canary-v0.2", priority=100))
    terminal = dispatcher.terminal_readback("restart-canary-v0.2")
    sentinel_states = [
        dispatcher.status("restart-sentinel-a")["state"],
        dispatcher.status("restart-sentinel-b")["state"],
    ]
    integrity = dispatcher.integrity()
    attempts = dispatcher.attempt_rows(terminal["job_id"])
    terminal_events = [event for event in dispatcher.event_rows(terminal["job_id"]) if event["terminal_unique"] == 1]
    with dispatcher._connect() as connection:
        live_wip = int(connection.execute(
            "SELECT COUNT(*) FROM jobs WHERE state IN ('DISPATCH_READY','RUNNING','RESULT_RECORDED')"
        ).fetchone()[0])
    if not duplicate["deduplicated"] or not terminal["done"]:
        raise RuntimeError("restart duplicate/readback gate failed")
    if sentinel_states != ["QUEUED", "QUEUED"]:
        raise RuntimeError("unrelated WIP changed")
    if integrity["counts"]["jobs"] != 3 or integrity["counts"]["claims"] != 1:
        raise RuntimeError("queue cardinality changed")
    if integrity["counts"]["results"] != 1 or integrity["counts"]["terminal_receipts"] != 1:
        raise RuntimeError("result or receipt was lost/duplicated")
    if len(attempts) != 1 or attempts[0]["outcome"] != "SUCCEEDED" or attempts[0]["effect_started"] != 1:
        raise RuntimeError("executor effect was lost/duplicated")
    if len(terminal_events) != 1 or live_wip != 0:
        raise RuntimeError("terminal event or live WIP invariant failed")
    dispatcher.checkpoint()
    return {
        "phase": name,
        "pid": pid,
        "job_id": terminal["job_id"],
        "claim_id": terminal["claim_id"],
        "effect_key": terminal["effect_key"],
        "result_sha256": terminal["result_sha256"],
        "receipt_sha256": terminal["receipt_sha256"],
        "recoveries": terminal["recoveries"],
        "sentinel_states": sentinel_states,
        "integrity": integrity,
        "attempt_count": len(attempts),
        "terminal_event_count": len(terminal_events),
        "live_wip": live_wip,
    }


def run_phase_process(script: Path, db_path: Path, name: str) -> dict[str, object]:
    completed = subprocess.run(
        [sys.executable, str(script), "--phase", name, "--db", str(db_path)],
        cwd=script.parents[2],
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
        env={"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8", "PYTHONPATH": str(script.parents[2])},
    )
    if completed.returncode != 0:
        raise RuntimeError(f"phase {name} failed")
    return json.loads(completed.stdout)


def run_restart_canary(db_path: Path | None = None) -> dict[str, object]:
    temporary: tempfile.TemporaryDirectory[str] | None = None
    if db_path is None:
        temporary = tempfile.TemporaryDirectory(prefix="search-dispatcher-restart-")
        db_path = Path(temporary.name) / "dispatcher.sqlite3"
    script = Path(__file__).resolve()
    phases = [run_phase_process(script, db_path, name) for name in ("seed", "recover", "execute", "verify", "readback")]
    if len({item["pid"] for item in phases}) != len(phases):
        raise RuntimeError("canary phases did not use distinct processes")
    seed, _, _, verify, readback = phases
    if not (
        seed["job_id"] == readback["job_id"]
        and seed["claim_id"] == readback["claim_id"]
        and seed["effect_key"] == readback["effect_key"]
        and verify["receipt_sha256"] == readback["receipt_sha256"]
        and readback["recoveries"] == 1
    ):
        raise RuntimeError("stable restart identity/readback invariant failed")
    result = {
        "status": "RESTART_CANARY_OK",
        "scope": "local_process_restart",
        "distinct_processes": len(phases),
        "job_id": readback["job_id"],
        "claim_id": readback["claim_id"],
        "effect_key": readback["effect_key"],
        "result_sha256": readback["result_sha256"],
        "receipt_sha256": readback["receipt_sha256"],
        "recoveries": readback["recoveries"],
        "attempt_count": readback["attempt_count"],
        "terminal_event_count": readback["terminal_event_count"],
        "sentinel_states": readback["sentinel_states"],
        "live_wip": readback["live_wip"],
        "phase_chain_sha256": canonical_hash(phases),
    }
    if temporary is not None:
        temporary.cleanup()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["seed", "recover", "execute", "verify", "readback"])
    parser.add_argument("--db", type=Path)
    args = parser.parse_args()
    try:
        if args.phase:
            if args.db is None:
                raise RuntimeError("phase requires --db")
            result = phase(args.db, args.phase)
        else:
            result = run_restart_canary(args.db)
        encoded = (json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        if args.phase in {"seed", "execute"}:
            os.write(1, encoded)
            os._exit(0)
        sys.stdout.buffer.write(encoded)
        return 0
    except Exception as error:
        print(json.dumps({"status": "CONTROL_PLANE_NOT_PERSISTENT", "error_code": type(error).__name__}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
