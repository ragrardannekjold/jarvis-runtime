from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from runtime.search_dispatcher import SearchDispatcher, canonical_hash


def canary_request() -> dict[str, object]:
    return {
        "schema_version": 2,
        "intent_id": "search-dispatcher-smoke-v0.2",
        "capability": "utility.catalog.search",
        "query": "github repository",
        "limit": 3,
        "priority": 100,
        "lane": "background",
        "correlation": {
            "mission_id": "CODE-P0-01",
            "route_id": "utility-search",
            "cell_id": "smoke",
        },
    }


def run_smoke() -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="search-dispatcher-smoke-") as directory:
        dispatcher = SearchDispatcher(Path(directory) / "dispatcher.sqlite3")
        submitted = dispatcher.submit(canary_request())
        terminal = dispatcher.run_one("smoke-worker")
        if terminal.get("state") != "VERIFIED" or terminal.get("truth_state") != "VERIFIED_COMPLETE" or terminal.get("done") is not True:
            raise RuntimeError("terminal readback did not verify")
        with dispatcher._connect() as connection:
            result_row = connection.execute(
                "SELECT result_json, result_sha256 FROM results WHERE job_id=?",
                (submitted["job_id"],),
            ).fetchone()
        result = json.loads(result_row["result_json"])
        output = result["executor_result"]["output"]
        if output["match_count"] < 1 or not any(item["id"] == "github.repo_ops" for item in output["matches"]):
            raise RuntimeError("real Utility Search output was not observed")
        kinds = [event["kind"] for event in dispatcher.event_rows(submitted["job_id"])]
        expected = [
            "INTENT_ACCEPTED", "ROUTE_ASSIGNED", "EXECUTION_STARTED",
            "RESULT_RECORDED", "TERMINAL_VERIFIED",
        ]
        if kinds != expected:
            raise RuntimeError("unexpected transition journal")
        integrity = dispatcher.integrity()
        if integrity["integrity_check"] != "ok" or integrity["counts"]["terminal_receipts"] != 1:
            raise RuntimeError("durable receipt integrity failed")
        return {
            "status": "SMOKE_OK",
            "executor": "utility-search.local-catalog",
            "job_id": submitted["job_id"],
            "result_sha256": terminal["result_sha256"],
            "receipt_sha256": terminal["receipt_sha256"],
            "journal_sha256": canonical_hash(kinds),
        }


if __name__ == "__main__":
    print(json.dumps(run_smoke(), sort_keys=True, separators=(",", ":")))
