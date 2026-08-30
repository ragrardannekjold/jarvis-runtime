from __future__ import annotations

import math
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime.search_dispatcher import (
    CapacityError,
    DispatcherError,
    ExecutionFailure,
    IdempotencyConflict,
    SearchDispatcher,
)
from runtime.search_dispatcher.dispatcher import validate_request


class MutableClock:
    def __init__(self, value: float = 1_000.0):
        self.value = value

    def __call__(self) -> float:
        return self.value


def request(
    intent_id: str,
    *,
    query: str = "github repository",
    lane: str = "background",
    priority: int = 50,
) -> dict[str, object]:
    return {
        "schema_version": 2,
        "intent_id": intent_id,
        "capability": "utility.catalog.search",
        "query": query,
        "limit": 3,
        "priority": priority,
        "lane": lane,
        "correlation": {
            "mission_id": "CODE-P0-01",
            "route_id": "search-dispatcher-v0.2",
            "cell_id": intent_id,
        },
    }


def executor_result(*, quality: float = 1.0) -> dict[str, object]:
    return {
        "schema_version": 1,
        "executor_id": "utility-search.local-catalog",
        "capability": "utility.catalog.search",
        "terminal_class": "SUCCESS",
        "effect_observation": "NO_EXTERNAL_EFFECT",
        "quality_score": quality,
        "evidence_refs": ["plugin/utility-search/lib/catalog.js"],
        "output": {"match_count": 1, "matches": [{"id": "github.repo_ops"}]},
    }


def route(
    route_id: str,
    *,
    executor_id: str = "utility-search.local-catalog",
    lane: str = "background",
    priority: int = 100,
    failure_domain: str = "domain-a",
    verification_state: str = "VERIFIED",
    health: str = "HEALTHY",
    execution_context: str = "COMPATIBLE_NONINTERACTIVE",
    zero_spend: bool = True,
    read_only: bool = True,
    idempotent: bool = True,
    effect_scope: str = "local_pure",
    max_parallel: int = 10,
) -> dict[str, object]:
    return {
        "route_id": route_id,
        "executor_id": executor_id,
        "capability": "utility.catalog.search",
        "lane": lane,
        "priority": priority,
        "failure_domain": failure_domain,
        "verification_state": verification_state,
        "health": health,
        "execution_context": execution_context,
        "zero_spend": zero_spend,
        "read_only": read_only,
        "idempotent": idempotent,
        "effect_scope": effect_scope,
        "timeout_seconds": 20,
        "max_parallel": max_parallel,
    }


class SearchDispatcherBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "dispatcher.sqlite3"

    def test_01_same_intent_and_hash_is_idempotent(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        first = dispatcher.submit(request("intent-idempotent"))
        second = dispatcher.submit(request("intent-idempotent"))
        self.assertEqual(first["job_id"], second["job_id"])
        self.assertFalse(first["deduplicated"])
        self.assertTrue(second["deduplicated"])
        self.assertEqual(dispatcher.integrity()["counts"]["jobs"], 1)
        self.assertEqual(dispatcher.integrity()["counts"]["claims"], 0)

    def test_02_same_intent_with_changed_payload_conflicts(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        original = dispatcher.submit(request("intent-conflict", query="github"))
        with self.assertRaises(IdempotencyConflict):
            dispatcher.submit(request("intent-conflict", query="google drive"))
        status = dispatcher.status("intent-conflict")
        self.assertEqual(status["request_sha256"], original["request_sha256"])
        self.assertEqual(dispatcher.integrity()["counts"]["jobs"], 1)

    def test_03_capacity_preserves_15_total_5_reserved_and_2_running(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        background_claims = []
        for index in range(11):
            dispatcher.submit(request(f"background-{index:02d}", lane="background", priority=100 - index))
        for index in range(10):
            claim = dispatcher.claim_next(f"bg-worker-{index}")
            self.assertIsNotNone(claim)
            background_claims.append(claim)
        self.assertIsNone(dispatcher.claim_next("bg-worker-overflow"))
        for index in range(5):
            dispatcher.submit(request(f"protected-{index:02d}", lane="protected", priority=90 - index))
            self.assertIsNotNone(dispatcher.claim_next(f"protected-worker-{index}"))
        dispatcher.submit(request("protected-overflow", lane="protected", priority=1))
        self.assertIsNone(dispatcher.claim_next("protected-worker-overflow"))
        dispatcher.mark_running(background_claims[0])
        dispatcher.mark_running(background_claims[1])
        with self.assertRaises(CapacityError):
            dispatcher.mark_running(background_claims[2])
        reopened = SearchDispatcher(self.db)
        with reopened._connect() as connection:
            counts = dict(connection.execute(
                "SELECT state, COUNT(*) FROM jobs GROUP BY state"
            ).fetchall())
        self.assertEqual(counts["RUNNING"], 2)
        self.assertEqual(counts["DISPATCH_READY"], 13)
        self.assertEqual(counts["QUEUED"], 2)

    def test_04_ineligible_head_does_not_consume_or_block_protected_work(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        for index in range(10):
            dispatcher.submit(request(f"fill-{index:02d}", priority=100 - index))
            self.assertIsNotNone(dispatcher.claim_next(f"fill-worker-{index}"))
        blocked = dispatcher.submit(request("blocked-high", lane="background", priority=100))
        fast = dispatcher.submit(request("fast-protected", lane="protected", priority=1))
        claim = dispatcher.claim_next("fast-worker")
        self.assertIsNotNone(claim)
        self.assertEqual(claim.job_id, fast["job_id"])
        self.assertEqual(dispatcher.status(blocked["job_id"])["state"], "QUEUED")

    def test_05_route_and_executor_policy_is_strictly_allowlisted(self) -> None:
        invalid = request("invalid-fields")
        invalid["command"] = "echo forbidden"
        with self.assertRaises(DispatcherError):
            validate_request(invalid)
        invalid_capability = request("invalid-capability")
        invalid_capability["capability"] = "arbitrary.shell"
        with self.assertRaises(DispatcherError):
            validate_request(invalid_capability)
        with self.assertRaises(DispatcherError):
            SearchDispatcher(self.db, routes=[route("bad-executor", executor_id="payload.command")])

        blocked_routes = [
            route("paid", priority=100, zero_spend=False),
            route("unverified", priority=90, verification_state="UNVERIFIED"),
            route("wrong-context", priority=80, execution_context="INTERACTIVE_ONLY_FOR_CONTEXT"),
        ]
        dispatcher = SearchDispatcher(self.db, routes=blocked_routes)
        queued = dispatcher.submit(request("no-eligible-route"))
        self.assertIsNone(dispatcher.claim_next("worker-policy"))
        self.assertEqual(dispatcher.status(queued["job_id"])["state"], "QUEUED")

    def test_06_pre_effect_failure_fails_over_once_to_independent_domain(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        job = dispatcher.submit(request("failover-real-executor"))
        with patch("runtime.search_dispatcher.dispatcher.shutil.which", return_value=None):
            result = dispatcher.run_one("worker-failover")
        self.assertTrue(result["done"])
        attempts = dispatcher.attempt_rows(job["job_id"])
        self.assertEqual([item["outcome"] for item in attempts], ["PRE_EFFECT_FAILURE", "SUCCEEDED"])
        self.assertEqual(attempts[0]["error_code"], "NODE_UNAVAILABLE")
        self.assertEqual(sum(item["effect_started"] for item in attempts), 1)
        self.assertEqual({item["failure_domain"] for item in attempts}, {"local-runtime", "bundled-snapshot-python"})
        self.assertEqual(result["effect_key"], dispatcher.status(job["job_id"])["effect_key"])

    def test_07_dispatch_ready_is_never_done(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        job = dispatcher.submit(request("ready-not-done"))
        self.assertIsNotNone(dispatcher.claim_next("worker-ready"))
        readback = dispatcher.terminal_readback(job["job_id"])
        self.assertEqual(readback["state"], "DISPATCH_READY")
        self.assertEqual(readback["truth_state"], "ACKNOWLEDGED_NOT_VERIFIED")
        self.assertFalse(readback["done"])
        self.assertEqual(dispatcher.integrity()["counts"]["terminal_receipts"], 0)

    def test_08_running_and_heartbeat_are_never_done(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        job = dispatcher.submit(request("running-not-done"))
        claim = dispatcher.claim_next("worker-running")
        self.assertIsNotNone(claim)
        dispatcher.mark_running(claim)
        dispatcher.heartbeat(claim)
        readback = dispatcher.terminal_readback(job["job_id"])
        self.assertEqual(readback["state"], "RUNNING")
        self.assertEqual(readback["truth_state"], "ATTEMPTED")
        self.assertFalse(readback["done"])
        self.assertEqual(dispatcher.integrity()["counts"]["terminal_receipts"], 0)

    def test_09_truth_guard_rejects_missing_or_nonfinite_proof(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        job = dispatcher.submit(request("invalid-proof"))
        claim = dispatcher.claim_next("worker-proof")
        self.assertIsNotNone(claim)
        dispatcher.mark_running(claim)
        with self.assertRaises(DispatcherError):
            dispatcher.verify_one(job["job_id"])
        with self.assertRaises(DispatcherError):
            dispatcher.record_result(claim, executor_result(quality=math.inf))
        readback = dispatcher.terminal_readback(job["job_id"])
        self.assertFalse(readback["done"])
        self.assertNotEqual(readback["truth_state"], "VERIFIED_COMPLETE")
        self.assertEqual(dispatcher.integrity()["counts"]["terminal_receipts"], 0)

        failure_db = Path(self.temp.name) / "failure-terminal.sqlite3"

        def proved_failure(_request, _route):
            raise ExecutionFailure("proved failure", code="PROVED_FAILURE", retryable=False, effect_started=False)

        failed_dispatcher = SearchDispatcher(
            failure_db,
            routes=[route("failure-route", executor_id="test.proved-failure")],
            executors={"test.proved-failure": proved_failure},
        )
        failed_dispatcher.submit(request("proved-failure-terminal"))
        failure = failed_dispatcher.run_one("worker-failure-terminal")
        self.assertEqual(failure["state"], "FAILED")
        self.assertTrue(failure["terminal"])
        self.assertFalse(failure["done"])
        self.assertTrue(failure["terminal_readback_verified"])
        self.assertIn("receipt_sha256", failure)

    def test_10_verified_requires_real_executor_immutable_hash_and_fresh_readback(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        job = dispatcher.submit(request("real-utility-search"))
        result = dispatcher.run_one("worker-real")
        self.assertTrue(result["done"])
        self.assertEqual(result["state"], "VERIFIED")
        self.assertEqual(result["truth_state"], "VERIFIED_COMPLETE")
        self.assertTrue(result["terminal_readback_verified"])
        self.assertEqual(dispatcher.attempt_rows(job["job_id"])[0]["outcome"], "SUCCEEDED")
        with dispatcher._connect() as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE results SET result_sha256='forged' WHERE job_id=?", (job["job_id"],))
        self.assertEqual(dispatcher.integrity()["integrity_check"], "ok")

    def test_11_expired_safe_lease_recovers_same_job_and_fences_stale_worker(self) -> None:
        clock = MutableClock()
        dispatcher = SearchDispatcher(self.db, clock=clock)
        job = dispatcher.submit(request("recover-safe"))
        stale = dispatcher.claim_next("worker-stale")
        self.assertIsNotNone(stale)
        dispatcher.mark_running(stale)
        clock.value += dispatcher.lease_seconds + 1
        with self.assertRaises(DispatcherError):
            dispatcher.heartbeat(stale)
        with self.assertRaises(DispatcherError):
            dispatcher.record_result(stale, executor_result())
        self.assertEqual(dispatcher.recover_expired(), {"recovered": 1, "blocked": 0})
        recovered = dispatcher.claim_next("worker-recovered")
        self.assertIsNotNone(recovered)
        self.assertEqual(recovered.job_id, job["job_id"])
        self.assertEqual(recovered.claim_id, stale.claim_id)
        self.assertEqual(recovered.effect_key, stale.effect_key)
        with self.assertRaises(DispatcherError):
            dispatcher.mark_running(stale)
        self.assertEqual(dispatcher.status(job["job_id"])["recoveries"], 1)

    def test_12_ambiguous_expired_execution_is_blocked_without_retry(self) -> None:
        clock = MutableClock()
        dispatcher = SearchDispatcher(self.db, clock=clock)
        job = dispatcher.submit(request("ambiguous-expiry"))
        claim = dispatcher.claim_next("worker-ambiguous")
        self.assertIsNotNone(claim)
        dispatcher.mark_running(claim)
        dispatcher.mark_effect_ambiguous(claim)
        clock.value += dispatcher.lease_seconds + 1
        self.assertEqual(dispatcher.recover_expired(), {"recovered": 0, "blocked": 1})
        status = dispatcher.status(job["job_id"])
        self.assertEqual(status["state"], "BLOCKED")
        self.assertEqual(status["truth_state"], "BLOCKED")
        terminal = dispatcher.terminal_readback(job["job_id"])
        self.assertTrue(terminal["terminal"])
        self.assertFalse(terminal["done"])
        self.assertTrue(terminal["terminal_readback_verified"])
        self.assertIsNone(dispatcher.claim_next("worker-no-retry"))
        self.assertEqual(dispatcher.integrity()["counts"]["attempts"], 0)

        removed_db = Path(self.temp.name) / "removed-route.sqlite3"
        removed_clock = MutableClock()
        old = SearchDispatcher(removed_db, routes=[route("old-route")], clock=removed_clock)
        old.submit(request("removed-route-ready"))
        self.assertIsNotNone(old.claim_next("worker-old-route"))
        removed_clock.value += old.lease_seconds + 1
        renamed = SearchDispatcher(
            removed_db,
            routes=[route("renamed-route", failure_domain="domain-b")],
            clock=removed_clock,
        )
        self.assertEqual(renamed.recover_expired(), {"recovered": 1, "blocked": 0})
        self.assertEqual(renamed.status("removed-route-ready")["state"], "QUEUED")

    def test_13_restart_replay_keeps_one_terminal_and_unrelated_jobs_queued(self) -> None:
        dispatcher = SearchDispatcher(self.db)
        job = dispatcher.submit(request("restart-terminal", priority=100))
        sentinel_a = dispatcher.submit(request("sentinel-a", priority=1))
        sentinel_b = dispatcher.submit(request("sentinel-b", priority=0))
        first = dispatcher.run_one("worker-before-restart", verify=False)
        self.assertEqual(first["state"], "RESULT_RECORDED")
        dispatcher.checkpoint()
        reopened = SearchDispatcher(self.db)
        adopted = reopened.run_one("worker-after-restart")
        duplicate = reopened.submit(request("restart-terminal", priority=100))
        readback = reopened.terminal_readback(job["job_id"])
        self.assertTrue(duplicate["deduplicated"])
        self.assertEqual(adopted["receipt_sha256"], readback["receipt_sha256"])
        self.assertEqual(adopted["result_sha256"], readback["result_sha256"])
        self.assertEqual(reopened.status(sentinel_a["job_id"])["state"], "QUEUED")
        self.assertEqual(reopened.status(sentinel_b["job_id"])["state"], "QUEUED")
        counts = reopened.integrity()["counts"]
        self.assertEqual(counts["jobs"], 3)
        self.assertEqual(counts["claims"], 1)
        self.assertEqual(counts["results"], 1)
        self.assertEqual(counts["terminal_receipts"], 1)
        self.assertEqual(len(reopened.attempt_rows(job["job_id"])), 1)


if __name__ == "__main__":
    unittest.main()
