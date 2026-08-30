from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping


SCHEMA_VERSION = 2
TERMINAL_STATES = frozenset({"VERIFIED", "FAILED", "BLOCKED"})
NONTERMINAL_STATES = frozenset({"QUEUED", "DISPATCH_READY", "RUNNING", "RESULT_RECORDED"})
TRUTH_PROPOSED = "PROPOSED"
TRUTH_ATTEMPTED = "ATTEMPTED"
TRUTH_ACKNOWLEDGED = "ACKNOWLEDGED_NOT_VERIFIED"
TRUTH_PARTIAL = "VERIFIED_PARTIAL"
TRUTH_COMPLETE = "VERIFIED_COMPLETE"
TRUTH_FAILED = "FAILED"
TRUTH_BLOCKED = "BLOCKED"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$")
REQUEST_KEYS = frozenset({
    "schema_version", "intent_id", "capability", "query", "limit",
    "priority", "lane", "correlation",
})
CORRELATION_KEYS = frozenset({"mission_id", "route_id", "cell_id"})
ROUTE_KEYS = frozenset({
    "route_id", "executor_id", "capability", "lane", "priority",
    "failure_domain", "verification_state", "health", "execution_context",
    "zero_spend", "read_only", "idempotent", "effect_scope",
    "timeout_seconds", "max_parallel",
})
RESULT_KEYS = frozenset({
    "schema_version", "executor_id", "capability", "terminal_class",
    "effect_observation", "quality_score", "evidence_refs", "output",
})


class DispatcherError(RuntimeError):
    code = "DISPATCHER_ERROR"

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        if code is not None:
            self.code = code


class IdempotencyConflict(DispatcherError):
    code = "IDEMPOTENCY_CONFLICT"


class CapacityError(DispatcherError):
    code = "PHYSICAL_CAPACITY_EXHAUSTED"


class ExecutionFailure(DispatcherError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "EXECUTOR_FAILED",
        retryable: bool = False,
        effect_started: bool = False,
    ):
        super().__init__(message, code=code)
        self.retryable = retryable
        self.effect_started = effect_started


@dataclass(frozen=True, slots=True)
class Claim:
    job_id: str
    intent_id: str
    claim_id: str
    effect_key: str
    generation: int
    worker_id: str
    route: dict[str, object]
    request: dict[str, object]
    lease_expires_at: float


def canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def canonical_hash(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _exact_keys(value: Mapping[str, object], expected: frozenset[str], label: str) -> None:
    if set(value) != expected:
        raise DispatcherError(f"{label} fields are not exactly allowlisted", code=f"{label.upper()}_FIELDS_NOT_ALLOWLISTED")


def _canonical_id(value: object, label: str) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise DispatcherError(f"invalid {label}", code=f"INVALID_{label.upper()}")
    return value


def validate_request(value: Mapping[str, object]) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise DispatcherError("request must be an object", code="INVALID_REQUEST")
    _exact_keys(value, REQUEST_KEYS, "request")
    if value.get("schema_version") != SCHEMA_VERSION:
        raise DispatcherError("unsupported request schema", code="UNSUPPORTED_SCHEMA")
    intent_id = _canonical_id(value.get("intent_id"), "intent_id")
    if value.get("capability") != "utility.catalog.search":
        raise DispatcherError("capability is not allowlisted", code="CAPABILITY_NOT_ALLOWLISTED")
    query = value.get("query")
    if not isinstance(query, str) or not query.strip() or len(query.encode("utf-8")) > 4_096:
        raise DispatcherError("query must be non-empty and bounded", code="INVALID_QUERY")
    limit = value.get("limit")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise DispatcherError("limit must be within 1..20", code="INVALID_LIMIT")
    priority = value.get("priority")
    if isinstance(priority, bool) or not isinstance(priority, int) or not 0 <= priority <= 100:
        raise DispatcherError("priority must be within 0..100", code="INVALID_PRIORITY")
    lane = value.get("lane")
    if lane not in {"background", "protected"}:
        raise DispatcherError("lane is not allowlisted", code="INVALID_LANE")
    correlation = value.get("correlation")
    if not isinstance(correlation, Mapping):
        raise DispatcherError("correlation must be an object", code="INVALID_CORRELATION")
    _exact_keys(correlation, CORRELATION_KEYS, "correlation")
    canonical_correlation = {
        key: _canonical_id(correlation.get(key), key) for key in sorted(CORRELATION_KEYS)
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "intent_id": intent_id,
        "capability": "utility.catalog.search",
        "query": query.strip(),
        "limit": limit,
        "priority": priority,
        "lane": lane,
        "correlation": canonical_correlation,
    }


def validate_route(value: Mapping[str, object], allowed_executors: set[str]) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise DispatcherError("route must be an object", code="INVALID_ROUTE")
    _exact_keys(value, ROUTE_KEYS, "route")
    route = dict(value)
    _canonical_id(route.get("route_id"), "route_id")
    executor_id = _canonical_id(route.get("executor_id"), "executor_id")
    if executor_id not in allowed_executors:
        raise DispatcherError("executor is not allowlisted", code="EXECUTOR_NOT_ALLOWLISTED")
    _canonical_id(route.get("failure_domain"), "failure_domain")
    if route.get("capability") != "utility.catalog.search":
        raise DispatcherError("route capability is not allowlisted", code="ROUTE_CAPABILITY_NOT_ALLOWLISTED")
    if route.get("lane") not in {"background", "protected"}:
        raise DispatcherError("route lane is invalid", code="INVALID_ROUTE_LANE")
    for key in ("priority", "timeout_seconds", "max_parallel"):
        number = route.get(key)
        if isinstance(number, bool) or not isinstance(number, int) or number < 1:
            raise DispatcherError(f"invalid route {key}", code="INVALID_ROUTE_LIMIT")
    for key in ("zero_spend", "read_only", "idempotent"):
        if not isinstance(route.get(key), bool):
            raise DispatcherError(f"invalid route {key}", code="INVALID_ROUTE_POLICY")
    if route.get("effect_scope") not in {"local_pure", "external"}:
        raise DispatcherError("invalid effect scope", code="INVALID_EFFECT_SCOPE")
    return route


def _load_truth_guard():
    root = Path(__file__).resolve().parents[2]
    core_path = root / "ci" / "ai49_core"
    if str(core_path) not in sys.path:
        sys.path.insert(0, str(core_path))
    from jarvis.truth_guard import TruthState, classify_truth_state
    return TruthState, classify_truth_state


class SearchDispatcher:
    def __init__(
        self,
        db_path: str | os.PathLike[str],
        *,
        config_path: str | os.PathLike[str] | None = None,
        routes: list[Mapping[str, object]] | None = None,
        executors: Mapping[str, Callable[[Mapping[str, object], Mapping[str, object]], Mapping[str, object]]] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.executors = dict(executors or {
            "utility-search.local-catalog": self._execute_utility_search,
            "utility-search.bundled-snapshot": self._execute_bundled_snapshot,
        })
        config_file = Path(config_path) if config_path else Path(__file__).with_name("config.v0.2.json")
        config = json.loads(config_file.read_text(encoding="utf-8"))
        if config.get("schema_version") != SCHEMA_VERSION:
            raise DispatcherError("unsupported dispatcher config", code="INVALID_CONFIG")
        capacity = config.get("capacity")
        if not isinstance(capacity, dict) or set(capacity) != {"logical_total", "protected_reserve", "physical_running"}:
            raise DispatcherError("invalid capacity config", code="INVALID_CONFIG")
        self.logical_total = int(capacity["logical_total"])
        self.protected_reserve = int(capacity["protected_reserve"])
        self.background_capacity = self.logical_total - self.protected_reserve
        self.physical_running = int(capacity["physical_running"])
        if (self.logical_total, self.protected_reserve, self.physical_running) != (15, 5, 2):
            raise DispatcherError("v0.2 capacity must remain 15/5 with physical cap 2", code="INVALID_CAPACITY")
        lease = config.get("lease_seconds")
        if isinstance(lease, bool) or not isinstance(lease, int) or not 1 <= lease <= 3_600:
            raise DispatcherError("invalid lease", code="INVALID_CONFIG")
        self.lease_seconds = lease
        configured_routes = routes if routes is not None else config.get("routes")
        if not isinstance(configured_routes, list) or not configured_routes:
            raise DispatcherError("routes must be non-empty", code="INVALID_CONFIG")
        self.routes = [validate_route(route, set(self.executors)) for route in configured_routes]
        self.routes.sort(key=lambda route: (-int(route["priority"]), str(route["route_id"])))
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=5.0, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _initialize(self) -> None:
        schema = """
        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY,
          intent_id TEXT NOT NULL UNIQUE,
          request_sha256 TEXT NOT NULL,
          request_json TEXT NOT NULL,
          capability TEXT NOT NULL,
          lane TEXT NOT NULL,
          priority INTEGER NOT NULL,
          state TEXT NOT NULL,
          truth_state TEXT NOT NULL,
          assigned_route_id TEXT,
          failed_domains_json TEXT NOT NULL DEFAULT '[]',
          attempts INTEGER NOT NULL DEFAULT 0,
          recoveries INTEGER NOT NULL DEFAULT 0,
          result_sha256 TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS claims (
          job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
          claim_id TEXT NOT NULL UNIQUE,
          effect_key TEXT NOT NULL UNIQUE,
          generation INTEGER NOT NULL,
          worker_id TEXT,
          route_id TEXT,
          phase TEXT NOT NULL,
          effect_state TEXT NOT NULL,
          lease_expires_at REAL,
          updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attempts (
          attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          claim_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          route_id TEXT NOT NULL,
          failure_domain TEXT NOT NULL,
          outcome TEXT NOT NULL,
          effect_started INTEGER NOT NULL,
          error_code TEXT,
          result_sha256 TEXT,
          created_at REAL NOT NULL,
          UNIQUE(job_id, generation)
        );
        CREATE TABLE IF NOT EXISTS results (
          job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
          claim_id TEXT NOT NULL,
          effect_key TEXT NOT NULL,
          generation INTEGER NOT NULL,
          route_id TEXT NOT NULL,
          request_sha256 TEXT NOT NULL,
          result_json TEXT NOT NULL,
          result_sha256 TEXT NOT NULL UNIQUE,
          recorded_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          previous_sha256 TEXT,
          event_sha256 TEXT NOT NULL UNIQUE,
          created_at REAL NOT NULL,
          terminal_unique INTEGER,
          UNIQUE(job_id, seq),
          UNIQUE(job_id, terminal_unique)
        );
        CREATE TABLE IF NOT EXISTS terminal_receipts (
          job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
          receipt_json TEXT NOT NULL,
          receipt_sha256 TEXT NOT NULL UNIQUE,
          created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS results_immutable_update
          BEFORE UPDATE ON results BEGIN SELECT RAISE(ABORT, 'results_are_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS results_immutable_delete
          BEFORE DELETE ON results BEGIN SELECT RAISE(ABORT, 'results_are_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS receipts_immutable_update
          BEFORE UPDATE ON terminal_receipts BEGIN SELECT RAISE(ABORT, 'terminal_receipts_are_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS receipts_immutable_delete
          BEFORE DELETE ON terminal_receipts BEGIN SELECT RAISE(ABORT, 'terminal_receipts_are_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS events_immutable_update
          BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events_are_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS events_immutable_delete
          BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events_are_immutable'); END;
        PRAGMA user_version=2;
        """
        with self._connect() as connection:
            connection.executescript(schema)
            connection.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )

    @staticmethod
    def _begin(connection: sqlite3.Connection) -> None:
        connection.execute("BEGIN IMMEDIATE")

    def _append_event(
        self,
        connection: sqlite3.Connection,
        job_id: str,
        kind: str,
        payload: Mapping[str, object],
        *,
        terminal: bool = False,
    ) -> str:
        previous = connection.execute(
            "SELECT seq, event_sha256 FROM events WHERE job_id=? ORDER BY seq DESC LIMIT 1",
            (job_id,),
        ).fetchone()
        seq = 1 if previous is None else int(previous["seq"]) + 1
        previous_sha = None if previous is None else str(previous["event_sha256"])
        created_at = float(self.clock())
        payload_json = canonical_json(dict(payload))
        material = {
            "job_id": job_id,
            "seq": seq,
            "kind": kind,
            "payload": json.loads(payload_json),
            "previous_sha256": previous_sha,
            "created_at": created_at,
        }
        event_sha = canonical_hash(material)
        connection.execute(
            """INSERT INTO events(
                 job_id, seq, kind, payload_json, previous_sha256,
                 event_sha256, created_at, terminal_unique
               ) VALUES(?,?,?,?,?,?,?,?)""",
            (job_id, seq, kind, payload_json, previous_sha, event_sha, created_at, 1 if terminal else None),
        )
        return event_sha

    def submit(self, request: Mapping[str, object]) -> dict[str, object]:
        canonical = validate_request(request)
        request_sha = canonical_hash(canonical)
        intent_id = str(canonical["intent_id"])
        job_id = f"JOB-{hashlib.sha256(intent_id.encode('utf-8')).hexdigest()[:24].upper()}"
        now = float(self.clock())
        with self._connect() as connection:
            self._begin(connection)
            existing = connection.execute(
                "SELECT job_id, request_sha256, state, truth_state FROM jobs WHERE intent_id=?",
                (intent_id,),
            ).fetchone()
            if existing is not None:
                if existing["request_sha256"] != request_sha:
                    connection.rollback()
                    raise IdempotencyConflict("same intent_id has a different canonical request")
                connection.commit()
                return {
                    "job_id": existing["job_id"],
                    "intent_id": intent_id,
                    "request_sha256": request_sha,
                    "state": existing["state"],
                    "truth_state": existing["truth_state"],
                    "deduplicated": True,
                }
            connection.execute(
                """INSERT INTO jobs(
                     job_id, intent_id, request_sha256, request_json, capability,
                     lane, priority, state, truth_state, created_at, updated_at
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    job_id, intent_id, request_sha, canonical_json(canonical),
                    canonical["capability"], canonical["lane"], canonical["priority"],
                    "QUEUED", TRUTH_PROPOSED, now, now,
                ),
            )
            self._append_event(connection, job_id, "INTENT_ACCEPTED", {
                "request_sha256": request_sha,
                "state": "QUEUED",
                "truth_state": TRUTH_PROPOSED,
            })
            connection.commit()
        return {
            "job_id": job_id,
            "intent_id": intent_id,
            "request_sha256": request_sha,
            "state": "QUEUED",
            "truth_state": TRUTH_PROPOSED,
            "deduplicated": False,
        }

    def _active_counts(self, connection: sqlite3.Connection) -> tuple[int, int, int]:
        active = connection.execute(
            "SELECT lane, COUNT(*) count FROM jobs WHERE state IN ('DISPATCH_READY','RUNNING') GROUP BY lane"
        ).fetchall()
        by_lane = {row["lane"]: int(row["count"]) for row in active}
        running = int(connection.execute("SELECT COUNT(*) FROM jobs WHERE state='RUNNING'").fetchone()[0])
        return by_lane.get("background", 0), by_lane.get("protected", 0), running

    def _eligible_route(
        self,
        connection: sqlite3.Connection,
        job: sqlite3.Row,
    ) -> dict[str, object] | None:
        failed_domains = set(json.loads(job["failed_domains_json"]))
        background, protected, _ = self._active_counts(connection)
        if job["lane"] == "background" and background >= self.background_capacity:
            return None
        if job["lane"] == "protected" and background + protected >= self.logical_total:
            return None
        for route in self.routes:
            if route["capability"] != job["capability"] or route["lane"] != job["lane"]:
                continue
            if route["failure_domain"] in failed_domains:
                continue
            if route["verification_state"] != "VERIFIED" or route["health"] != "HEALTHY":
                continue
            if route["execution_context"] != "COMPATIBLE_NONINTERACTIVE":
                continue
            if route["zero_spend"] is not True or route["read_only"] is not True or route["idempotent"] is not True:
                continue
            assigned = int(connection.execute(
                "SELECT COUNT(*) FROM jobs WHERE assigned_route_id=? AND state IN ('DISPATCH_READY','RUNNING')",
                (route["route_id"],),
            ).fetchone()[0])
            if assigned >= int(route["max_parallel"]):
                continue
            return route
        return None

    def _row_to_claim(self, row: sqlite3.Row, route: Mapping[str, object]) -> Claim:
        return Claim(
            job_id=str(row["job_id"]),
            intent_id=str(row["intent_id"]),
            claim_id=str(row["claim_id"]),
            effect_key=str(row["effect_key"]),
            generation=int(row["generation"]),
            worker_id=str(row["worker_id"]),
            route=dict(route),
            request=json.loads(row["request_json"]),
            lease_expires_at=float(row["lease_expires_at"]),
        )

    def claim_next(self, worker_id: str, *, only_job_id: str | None = None) -> Claim | None:
        _canonical_id(worker_id, "worker_id")
        now = float(self.clock())
        with self._connect() as connection:
            self._begin(connection)
            if only_job_id:
                jobs = connection.execute(
                    "SELECT * FROM jobs WHERE state='QUEUED' AND job_id=?",
                    (only_job_id,),
                ).fetchall()
            else:
                jobs = connection.execute(
                    "SELECT * FROM jobs WHERE state='QUEUED' ORDER BY priority DESC, created_at, job_id"
                ).fetchall()
            selected: sqlite3.Row | None = None
            route: dict[str, object] | None = None
            for candidate in jobs:
                candidate_route = self._eligible_route(connection, candidate)
                if candidate_route is not None:
                    selected = candidate
                    route = candidate_route
                    break
            if selected is None or route is None:
                connection.commit()
                return None
            existing_claim = connection.execute(
                "SELECT * FROM claims WHERE job_id=?", (selected["job_id"],)
            ).fetchone()
            if existing_claim is None:
                claim_id = f"CLM-{hashlib.sha256(str(selected['job_id']).encode()).hexdigest()[:24].upper()}"
                effect_key = f"EFF-{hashlib.sha256((str(selected['request_sha256']) + ':v2').encode()).hexdigest()[:24].upper()}"
                generation = 1
                connection.execute(
                    """INSERT INTO claims(
                         job_id, claim_id, effect_key, generation, worker_id, route_id,
                         phase, effect_state, lease_expires_at, updated_at
                       ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (
                        selected["job_id"], claim_id, effect_key, generation, worker_id,
                        route["route_id"], "DISPATCH_READY", "NOT_STARTED",
                        now + self.lease_seconds, now,
                    ),
                )
            else:
                claim_id = str(existing_claim["claim_id"])
                effect_key = str(existing_claim["effect_key"])
                generation = int(existing_claim["generation"]) + 1
                connection.execute(
                    """UPDATE claims SET generation=?, worker_id=?, route_id=?, phase='DISPATCH_READY',
                         effect_state='NOT_STARTED', lease_expires_at=?, updated_at=? WHERE job_id=?""",
                    (generation, worker_id, route["route_id"], now + self.lease_seconds, now, selected["job_id"]),
                )
            changed = connection.execute(
                """UPDATE jobs SET state='DISPATCH_READY', truth_state=?, assigned_route_id=?,
                     attempts=attempts+1, revision=revision+1, updated_at=?
                   WHERE job_id=? AND state='QUEUED'""",
                (TRUTH_ACKNOWLEDGED, route["route_id"], now, selected["job_id"]),
            ).rowcount
            if changed != 1:
                connection.rollback()
                return None
            self._append_event(connection, selected["job_id"], "ROUTE_ASSIGNED", {
                "claim_id": claim_id,
                "effect_key": effect_key,
                "generation": generation,
                "route_id": route["route_id"],
                "worker_id": worker_id,
                "state": "DISPATCH_READY",
                "truth_state": TRUTH_ACKNOWLEDGED,
            })
            row = connection.execute(
                """SELECT j.*, c.claim_id, c.effect_key, c.generation, c.worker_id,
                          c.lease_expires_at FROM jobs j JOIN claims c USING(job_id) WHERE j.job_id=?""",
                (selected["job_id"],),
            ).fetchone()
            connection.commit()
        return self._row_to_claim(row, route)

    def _route_by_id(self, route_id: str) -> dict[str, object]:
        for route in self.routes:
            if route["route_id"] == route_id:
                return route
        raise DispatcherError("assigned route disappeared", code="ROUTE_NOT_FOUND")

    def _assert_fence(self, row: sqlite3.Row | None, claim: Claim) -> None:
        if row is None:
            raise DispatcherError("claim not found", code="CLAIM_NOT_FOUND")
        if (
            row["claim_id"] != claim.claim_id
            or int(row["generation"]) != claim.generation
            or row["worker_id"] != claim.worker_id
        ):
            raise DispatcherError("stale worker fence", code="STALE_WORKER_FENCE")

    @staticmethod
    def _assert_live_lease(row: sqlite3.Row, now: float) -> None:
        expiry = row["lease_expires_at"]
        if expiry is None or float(expiry) <= now:
            raise DispatcherError("lease expired", code="LEASE_EXPIRED")

    def mark_running(self, claim: Claim) -> None:
        now = float(self.clock())
        with self._connect() as connection:
            self._begin(connection)
            claim_row = connection.execute("SELECT * FROM claims WHERE job_id=?", (claim.job_id,)).fetchone()
            self._assert_fence(claim_row, claim)
            job = connection.execute("SELECT * FROM jobs WHERE job_id=?", (claim.job_id,)).fetchone()
            if job is None or job["state"] != "DISPATCH_READY":
                raise DispatcherError("job is not dispatch-ready", code="INVALID_TRANSITION")
            self._assert_live_lease(claim_row, now)
            running = int(connection.execute("SELECT COUNT(*) FROM jobs WHERE state='RUNNING'").fetchone()[0])
            if running >= self.physical_running:
                connection.rollback()
                raise CapacityError("physical executor capacity is exhausted")
            route = self._route_by_id(str(claim_row["route_id"]))
            effect_state = "NO_EXTERNAL_EFFECT_PROVED" if route["effect_scope"] == "local_pure" else "MAY_HAVE_STARTED"
            connection.execute(
                "UPDATE claims SET phase='RUNNING', effect_state=?, updated_at=? WHERE job_id=?",
                (effect_state, now, claim.job_id),
            )
            connection.execute(
                "UPDATE jobs SET state='RUNNING', truth_state=?, revision=revision+1, updated_at=? WHERE job_id=?",
                (TRUTH_ATTEMPTED, now, claim.job_id),
            )
            self._append_event(connection, claim.job_id, "EXECUTION_STARTED", {
                "claim_id": claim.claim_id,
                "generation": claim.generation,
                "route_id": claim.route["route_id"],
                "worker_id": claim.worker_id,
                "effect_state": effect_state,
                "state": "RUNNING",
                "truth_state": TRUTH_ATTEMPTED,
            })
            connection.commit()

    def heartbeat(self, claim: Claim) -> None:
        now = float(self.clock())
        with self._connect() as connection:
            self._begin(connection)
            row = connection.execute("SELECT * FROM claims WHERE job_id=?", (claim.job_id,)).fetchone()
            self._assert_fence(row, claim)
            self._assert_live_lease(row, now)
            state = connection.execute("SELECT state FROM jobs WHERE job_id=?", (claim.job_id,)).fetchone()
            if state is None or state["state"] != "RUNNING":
                raise DispatcherError("heartbeat requires RUNNING", code="INVALID_HEARTBEAT")
            connection.execute(
                "UPDATE claims SET lease_expires_at=?, updated_at=? WHERE job_id=?",
                (now + self.lease_seconds, now, claim.job_id),
            )
            self._append_event(connection, claim.job_id, "HEARTBEAT", {
                "claim_id": claim.claim_id,
                "generation": claim.generation,
                "worker_id": claim.worker_id,
            })
            connection.commit()

    def mark_effect_ambiguous(self, claim: Claim) -> None:
        """Persist uncertainty before a potentially effectful boundary.

        This is deliberately separate from heartbeat: an expired claim with this
        marker is quarantined and is never retried automatically.
        """
        now = float(self.clock())
        with self._connect() as connection:
            self._begin(connection)
            row = connection.execute("SELECT * FROM claims WHERE job_id=?", (claim.job_id,)).fetchone()
            self._assert_fence(row, claim)
            self._assert_live_lease(row, now)
            state = connection.execute("SELECT state FROM jobs WHERE job_id=?", (claim.job_id,)).fetchone()
            if state is None or state["state"] != "RUNNING":
                raise DispatcherError("effect marker requires RUNNING", code="INVALID_EFFECT_MARKER")
            connection.execute(
                "UPDATE claims SET effect_state='MAY_HAVE_STARTED', updated_at=? WHERE job_id=?",
                (now, claim.job_id),
            )
            self._append_event(connection, claim.job_id, "EFFECT_AMBIGUOUS", {
                "claim_id": claim.claim_id,
                "generation": claim.generation,
                "worker_id": claim.worker_id,
            })
            connection.commit()

    def _execute_utility_search(
        self,
        request: Mapping[str, object],
        route: Mapping[str, object],
    ) -> Mapping[str, object]:
        node = shutil.which("node")
        if node is None:
            raise ExecutionFailure("Node.js is unavailable", code="NODE_UNAVAILABLE", retryable=True, effect_started=False)
        script = Path(__file__).with_name("utility_search_executor.mjs")
        payload = canonical_json({"query": request["query"], "limit": request["limit"]})
        try:
            completed = subprocess.run(
                [node, str(script)],
                input=payload,
                text=True,
                capture_output=True,
                timeout=int(route["timeout_seconds"]),
                check=False,
                env={"LANG": "C.UTF-8"},
            )
        except subprocess.TimeoutExpired as error:
            raise ExecutionFailure("Utility Search timed out", code="EXECUTOR_TIMEOUT", retryable=True, effect_started=False) from error
        if completed.returncode != 0:
            raise ExecutionFailure("Utility Search failed", code="UTILITY_SEARCH_FAILED", retryable=True, effect_started=False)
        if len(completed.stdout.encode("utf-8")) > 256 * 1024:
            raise ExecutionFailure("Utility Search output exceeded limit", code="EXECUTOR_OUTPUT_TOO_LARGE", retryable=True, effect_started=False)
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise ExecutionFailure("Utility Search returned invalid JSON", code="EXECUTOR_OUTPUT_INVALID", retryable=True, effect_started=False) from error
        return result

    def _execute_bundled_snapshot(
        self,
        request: Mapping[str, object],
        route: Mapping[str, object],
    ) -> Mapping[str, object]:
        snapshot_path = Path(__file__).with_name("fallback-catalog.v0.2.json")
        try:
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ExecutionFailure("bundled snapshot is unavailable", code="SNAPSHOT_UNAVAILABLE") from error
        if set(snapshot) != {"schema_version", "source_path", "source_sha256", "utilities"} or snapshot.get("schema_version") != 1:
            raise ExecutionFailure("bundled snapshot contract is invalid", code="SNAPSHOT_INVALID")
        source_path = Path(__file__).resolve().parents[2] / str(snapshot["source_path"])
        try:
            source_sha = hashlib.sha256(source_path.read_bytes()).hexdigest()
        except OSError as error:
            raise ExecutionFailure("snapshot source is unavailable", code="SNAPSHOT_SOURCE_UNAVAILABLE") from error
        if source_sha != snapshot.get("source_sha256"):
            raise ExecutionFailure("bundled snapshot is stale", code="SNAPSHOT_STALE")
        utilities = snapshot.get("utilities")
        if not isinstance(utilities, list):
            raise ExecutionFailure("bundled snapshot utilities are invalid", code="SNAPSHOT_INVALID")

        def tokens(value: object) -> set[str]:
            normalized = unicodedata.normalize("NFKD", str(value).casefold())
            return set(re.findall(r"[\w.-]+", normalized, flags=re.UNICODE))

        query_text = str(request["query"]).strip()
        query_tokens = tokens(query_text)
        ranked: list[tuple[float, dict[str, object]]] = []
        for raw in utilities:
            if not isinstance(raw, dict):
                raise ExecutionFailure("bundled snapshot entry is invalid", code="SNAPSHOT_INVALID")
            required = {
                "id", "name", "url", "aliases", "intents", "capabilities", "cost_class",
                "max_usd_per_run", "risk_mode", "confirmation_required", "health", "priority",
            }
            if set(raw) != required or raw["cost_class"] not in {"free", "included"} or raw["max_usd_per_run"] != 0 or raw["health"] != "healthy":
                raise ExecutionFailure("bundled snapshot policy is invalid", code="SNAPSHOT_INVALID")
            searchable = " ".join([
                str(raw["id"]), str(raw["name"]),
                *map(str, raw["aliases"]), *map(str, raw["intents"]), *map(str, raw["capabilities"]),
            ])
            candidate_tokens = tokens(searchable)
            overlap = len(query_tokens & candidate_tokens)
            score = overlap * 20 + (15 if query_text.casefold() in searchable.casefold() else 0) + float(raw["priority"]) / 20
            if score > 0:
                ranked.append((score, raw))
        ranked.sort(key=lambda item: (-item[0], str(item[1]["name"])))
        matches = [{
            "id": item["id"],
            "name": item["name"],
            "url": item["url"],
            "score": round(score, 2),
            "cost_class": item["cost_class"],
            "max_usd_per_run": item["max_usd_per_run"],
            "risk_mode": item["risk_mode"],
            "confirmation_required": item["confirmation_required"],
            "health": item["health"],
        } for score, item in ranked[: int(request["limit"])]]
        return {
            "schema_version": 1,
            "executor_id": route["executor_id"],
            "capability": "utility.catalog.search",
            "terminal_class": "SUCCESS",
            "effect_observation": "NO_EXTERNAL_EFFECT",
            "quality_score": 0.9,
            "evidence_refs": [
                "runtime/search_dispatcher/fallback-catalog.v0.2.json",
                f"sha256:{source_sha}",
            ],
            "output": {"query": query_text, "match_count": len(matches), "matches": matches},
        }

    def _record_attempt(
        self,
        connection: sqlite3.Connection,
        claim: Claim,
        *,
        outcome: str,
        effect_started: bool,
        error_code: str | None = None,
        result_sha256: str | None = None,
    ) -> None:
        connection.execute(
            """INSERT INTO attempts(
                 job_id, claim_id, generation, route_id, failure_domain,
                 outcome, effect_started, error_code, result_sha256, created_at
               ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                claim.job_id, claim.claim_id, claim.generation, claim.route["route_id"],
                claim.route["failure_domain"], outcome, 1 if effect_started else 0,
                error_code, result_sha256, float(self.clock()),
            ),
        )

    def _insert_terminal_receipt(
        self,
        connection: sqlite3.Connection,
        job_id: str,
        *,
        state: str,
        truth_state: str,
        error_code: str | None,
    ) -> str:
        if state not in TERMINAL_STATES:
            raise DispatcherError("terminal receipt requires terminal state", code="INVALID_TERMINAL_STATE")
        row = connection.execute(
            """SELECT j.*, c.claim_id, c.effect_key, c.generation, c.route_id
               FROM jobs j JOIN claims c USING(job_id) WHERE j.job_id=?""",
            (job_id,),
        ).fetchone()
        if row is None:
            raise DispatcherError("terminal receipt binding is missing", code="TERMINAL_BINDING_MISSING")
        receipt = {
            "schema_version": SCHEMA_VERSION,
            "job_id": job_id,
            "intent_id": row["intent_id"],
            "request_sha256": row["request_sha256"],
            "claim_id": row["claim_id"],
            "effect_key": row["effect_key"],
            "generation": int(row["generation"]),
            "route_id": row["route_id"] or row["assigned_route_id"],
            "result_sha256": row["result_sha256"],
            "state": state,
            "truth_state": truth_state,
            "error_code": error_code,
            "terminal_readback_verified": state == "VERIFIED",
        }
        receipt_sha = canonical_hash(receipt)
        connection.execute(
            "INSERT INTO terminal_receipts(job_id, receipt_json, receipt_sha256, created_at) VALUES(?,?,?,?)",
            (job_id, canonical_json(receipt), receipt_sha, float(self.clock())),
        )
        return receipt_sha

    def record_result(self, claim: Claim, result: Mapping[str, object]) -> str:
        if not isinstance(result, Mapping):
            raise DispatcherError("executor result must be an object", code="INVALID_RESULT")
        _exact_keys(result, RESULT_KEYS, "result")
        if result.get("schema_version") != 1 or result.get("executor_id") != claim.route["executor_id"]:
            raise DispatcherError("executor result binding failed", code="INVALID_RESULT_BINDING")
        if result.get("capability") != claim.request["capability"] or result.get("terminal_class") != "SUCCESS":
            raise DispatcherError("executor did not prove success", code="INVALID_TERMINAL_CLASS")
        if result.get("effect_observation") != "NO_EXTERNAL_EFFECT":
            raise DispatcherError("external effect is not admissible", code="EXTERNAL_EFFECT_NOT_ADMISSIBLE")
        quality = result.get("quality_score")
        if isinstance(quality, bool) or not isinstance(quality, (int, float)) or not math.isfinite(float(quality)) or not 0.5 <= float(quality) <= 1.0:
            raise DispatcherError("quality proof is invalid", code="INVALID_QUALITY_PROOF")
        evidence = result.get("evidence_refs")
        if not isinstance(evidence, list) or not evidence or any(not isinstance(item, str) or not item for item in evidence):
            raise DispatcherError("evidence proof is invalid", code="INVALID_EVIDENCE_PROOF")
        result_document = {
            "schema_version": SCHEMA_VERSION,
            "job_id": claim.job_id,
            "intent_id": claim.intent_id,
            "claim_id": claim.claim_id,
            "effect_key": claim.effect_key,
            "generation": claim.generation,
            "route_id": claim.route["route_id"],
            "request_sha256": canonical_hash(claim.request),
            "executor_result": dict(result),
        }
        result_sha = canonical_hash(result_document)
        now = float(self.clock())
        with self._connect() as connection:
            self._begin(connection)
            claim_row = connection.execute("SELECT * FROM claims WHERE job_id=?", (claim.job_id,)).fetchone()
            self._assert_fence(claim_row, claim)
            self._assert_live_lease(claim_row, now)
            job = connection.execute("SELECT * FROM jobs WHERE job_id=?", (claim.job_id,)).fetchone()
            if job is None or job["state"] != "RUNNING":
                raise DispatcherError("result requires RUNNING", code="INVALID_TRANSITION")
            if job["request_sha256"] != result_document["request_sha256"]:
                raise DispatcherError("request hash binding failed", code="INVALID_RESULT_BINDING")
            connection.execute(
                """INSERT INTO results(
                     job_id, claim_id, effect_key, generation, route_id,
                     request_sha256, result_json, result_sha256, recorded_at
                   ) VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    claim.job_id, claim.claim_id, claim.effect_key, claim.generation,
                    claim.route["route_id"], result_document["request_sha256"],
                    canonical_json(result_document), result_sha, now,
                ),
            )
            self._record_attempt(connection, claim, outcome="SUCCEEDED", effect_started=True, result_sha256=result_sha)
            connection.execute(
                "UPDATE claims SET phase='RESULT_RECORDED', effect_state='NO_EXTERNAL_EFFECT_PROVED', lease_expires_at=NULL, updated_at=? WHERE job_id=?",
                (now, claim.job_id),
            )
            connection.execute(
                "UPDATE jobs SET state='RESULT_RECORDED', truth_state=?, result_sha256=?, revision=revision+1, updated_at=? WHERE job_id=?",
                (TRUTH_PARTIAL, result_sha, now, claim.job_id),
            )
            self._append_event(connection, claim.job_id, "RESULT_RECORDED", {
                "claim_id": claim.claim_id,
                "effect_key": claim.effect_key,
                "generation": claim.generation,
                "result_sha256": result_sha,
                "state": "RESULT_RECORDED",
                "truth_state": TRUTH_PARTIAL,
            })
            connection.commit()
        return result_sha

    def _handle_failure(self, claim: Claim, error: ExecutionFailure) -> str:
        now = float(self.clock())
        with self._connect() as connection:
            self._begin(connection)
            claim_row = connection.execute("SELECT * FROM claims WHERE job_id=?", (claim.job_id,)).fetchone()
            self._assert_fence(claim_row, claim)
            self._assert_live_lease(claim_row, now)
            self._record_attempt(
                connection,
                claim,
                outcome="PRE_EFFECT_FAILURE" if not error.effect_started else "AMBIGUOUS_FAILURE",
                effect_started=error.effect_started,
                error_code=error.code,
            )
            if error.retryable and not error.effect_started:
                job = connection.execute("SELECT failed_domains_json FROM jobs WHERE job_id=?", (claim.job_id,)).fetchone()
                failed = set(json.loads(job["failed_domains_json"]))
                failed.add(str(claim.route["failure_domain"]))
                connection.execute(
                    """UPDATE jobs SET state='QUEUED', truth_state=?, assigned_route_id=NULL,
                         failed_domains_json=?, revision=revision+1, updated_at=? WHERE job_id=?""",
                    (TRUTH_ATTEMPTED, canonical_json(sorted(failed)), now, claim.job_id),
                )
                connection.execute(
                    "UPDATE claims SET phase='PRE_EFFECT_FAILED', effect_state='NOT_STARTED', lease_expires_at=NULL, updated_at=? WHERE job_id=?",
                    (now, claim.job_id),
                )
                self._append_event(connection, claim.job_id, "PRE_EFFECT_FAILURE", {
                    "generation": claim.generation,
                    "route_id": claim.route["route_id"],
                    "failure_domain": claim.route["failure_domain"],
                    "error_code": error.code,
                    "state": "QUEUED",
                })
                state = "QUEUED"
            else:
                state = "BLOCKED" if error.effect_started else "FAILED"
                truth = TRUTH_BLOCKED if error.effect_started else TRUTH_FAILED
                connection.execute(
                    "UPDATE jobs SET state=?, truth_state=?, revision=revision+1, updated_at=? WHERE job_id=?",
                    (state, truth, now, claim.job_id),
                )
                connection.execute(
                    "UPDATE claims SET phase=?, lease_expires_at=NULL, updated_at=? WHERE job_id=?",
                    (state, now, claim.job_id),
                )
                receipt_sha = self._insert_terminal_receipt(
                    connection,
                    claim.job_id,
                    state=state,
                    truth_state=truth,
                    error_code=error.code,
                )
                self._append_event(connection, claim.job_id, "EXECUTION_TERMINATED", {
                    "generation": claim.generation,
                    "route_id": claim.route["route_id"],
                    "error_code": error.code,
                    "receipt_sha256": receipt_sha,
                    "state": state,
                    "truth_state": truth,
                }, terminal=True)
            connection.commit()
        return state

    def execute_claim(self, claim: Claim) -> str:
        self.mark_running(claim)
        executor = self.executors.get(str(claim.route["executor_id"]))
        if executor is None:
            return self._handle_failure(claim, ExecutionFailure("executor not found", code="EXECUTOR_NOT_ALLOWLISTED"))
        try:
            result = executor(claim.request, claim.route)
            self.record_result(claim, result)
            return "RESULT_RECORDED"
        except ExecutionFailure as error:
            return self._handle_failure(claim, error)
        except DispatcherError as error:
            safe_proof_failures = {
                "INVALID_RESULT", "RESULT_FIELDS_NOT_ALLOWLISTED", "INVALID_RESULT_BINDING",
                "INVALID_TERMINAL_CLASS", "EXTERNAL_EFFECT_NOT_ADMISSIBLE",
                "INVALID_QUALITY_PROOF", "INVALID_EVIDENCE_PROOF",
            }
            if claim.route["effect_scope"] == "local_pure" and error.code in safe_proof_failures:
                return self._handle_failure(claim, ExecutionFailure(
                    "local executor proof failed",
                    code=error.code,
                    retryable=True,
                    effect_started=False,
                ))
            raise
        except Exception as error:
            local_pure = claim.route["effect_scope"] == "local_pure"
            return self._handle_failure(claim, ExecutionFailure(
                "executor raised unexpectedly",
                code="EXECUTOR_EXCEPTION",
                retryable=local_pure,
                effect_started=not local_pure,
            ))

    def run_one(self, worker_id: str, *, verify: bool = True, max_failovers: int = 3) -> dict[str, object]:
        if verify:
            with self._connect() as connection:
                pending_result = connection.execute(
                    "SELECT job_id FROM jobs WHERE state='RESULT_RECORDED' ORDER BY updated_at, job_id LIMIT 1"
                ).fetchone()
            if pending_result is not None:
                return self.verify_one(str(pending_result["job_id"]))
        claim = self.claim_next(worker_id)
        if claim is None:
            return {"state": "IDLE", "truth_state": TRUTH_PROPOSED, "done": False}
        target_job = claim.job_id
        for _ in range(max_failovers + 1):
            state = self.execute_claim(claim)
            if state == "RESULT_RECORDED":
                if verify:
                    self.verify_one(target_job)
                return self.terminal_readback(target_job)
            if state != "QUEUED":
                return self.terminal_readback(target_job) if state in TERMINAL_STATES else self.status(target_job)
            next_claim = self.claim_next(worker_id, only_job_id=target_job)
            if next_claim is None:
                return self.status(target_job)
            claim = next_claim
        return self.status(target_job)

    def verify_one(self, job_id: str) -> dict[str, object]:
        _canonical_id(job_id, "job_id")
        with self._connect() as readback:
            row = readback.execute(
                """SELECT j.*, r.claim_id result_claim_id, r.effect_key, r.generation,
                          r.route_id result_route_id, r.request_sha256 result_request_sha256,
                          r.result_json, r.result_sha256 stored_result_sha256,
                          c.claim_id current_claim_id, c.effect_key current_effect_key
                   FROM jobs j JOIN results r USING(job_id) JOIN claims c USING(job_id)
                   WHERE j.job_id=?""",
                (job_id,),
            ).fetchone()
        if row is None:
            raise DispatcherError("persisted result is missing", code="RESULT_NOT_FOUND")
        if row["state"] == "VERIFIED":
            return self.terminal_readback(job_id)
        if row["state"] != "RESULT_RECORDED":
            raise DispatcherError("verification requires RESULT_RECORDED", code="INVALID_TRANSITION")
        document = json.loads(row["result_json"])
        if canonical_hash(document) != row["stored_result_sha256"] or row["result_sha256"] != row["stored_result_sha256"]:
            raise DispatcherError("result hash readback failed", code="RESULT_HASH_MISMATCH")
        bindings = (
            document.get("job_id") == job_id,
            document.get("claim_id") == row["result_claim_id"] == row["current_claim_id"],
            document.get("effect_key") == row["effect_key"] == row["current_effect_key"],
            document.get("route_id") == row["result_route_id"] == row["assigned_route_id"],
            document.get("request_sha256") == row["result_request_sha256"] == row["request_sha256"],
        )
        if not all(bindings):
            raise DispatcherError("terminal bindings failed", code="TERMINAL_BINDING_MISMATCH")
        executor_result = document.get("executor_result")
        if not isinstance(executor_result, dict):
            raise DispatcherError("executor proof missing", code="INVALID_RESULT")
        quality = executor_result.get("quality_score")
        if isinstance(quality, bool) or not isinstance(quality, (int, float)) or not math.isfinite(float(quality)) or float(quality) < 0.5:
            raise DispatcherError("quality gate failed", code="INVALID_QUALITY_PROOF")
        evidence = executor_result.get("evidence_refs")
        quality_passed = (
            executor_result.get("terminal_class") == "SUCCESS"
            and executor_result.get("effect_observation") == "NO_EXTERNAL_EFFECT"
            and isinstance(evidence, list)
            and bool(evidence)
        )
        TruthState, classify_truth_state = _load_truth_guard()
        truth_state = classify_truth_state(
            attempted=True,
            acknowledged=True,
            result_present=True,
            terminal_readback_verified=True,
            quality_gate_passed=quality_passed,
        )
        if truth_state != TruthState.VERIFIED_COMPLETE:
            raise DispatcherError("truth guard denied terminal promotion", code="TRUTH_GUARD_DENIED")
        receipt = {
            "schema_version": SCHEMA_VERSION,
            "job_id": job_id,
            "intent_id": row["intent_id"],
            "request_sha256": row["request_sha256"],
            "claim_id": row["result_claim_id"],
            "effect_key": row["effect_key"],
            "generation": int(row["generation"]),
            "route_id": row["result_route_id"],
            "result_sha256": row["stored_result_sha256"],
            "state": "VERIFIED",
            "truth_state": TRUTH_COMPLETE,
            "error_code": None,
            "terminal_readback_verified": True,
        }
        receipt_sha = canonical_hash(receipt)
        now = float(self.clock())
        with self._connect() as connection:
            self._begin(connection)
            fresh = connection.execute("SELECT state, result_sha256 FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if fresh is None or fresh["state"] != "RESULT_RECORDED" or fresh["result_sha256"] != row["stored_result_sha256"]:
                raise DispatcherError("verification fence changed", code="VERIFICATION_FENCE_CHANGED")
            connection.execute(
                "INSERT INTO terminal_receipts(job_id, receipt_json, receipt_sha256, created_at) VALUES(?,?,?,?)",
                (job_id, canonical_json(receipt), receipt_sha, now),
            )
            connection.execute(
                "UPDATE jobs SET state='VERIFIED', truth_state=?, revision=revision+1, updated_at=? WHERE job_id=?",
                (TRUTH_COMPLETE, now, job_id),
            )
            connection.execute("UPDATE claims SET phase='VERIFIED', updated_at=? WHERE job_id=?", (now, job_id))
            self._append_event(connection, job_id, "TERMINAL_VERIFIED", {
                "receipt_sha256": receipt_sha,
                "result_sha256": row["stored_result_sha256"],
                "state": "VERIFIED",
                "truth_state": TRUTH_COMPLETE,
            }, terminal=True)
            connection.commit()
        return self.terminal_readback(job_id)

    def recover_expired(self) -> dict[str, int]:
        now = float(self.clock())
        recovered = 0
        blocked = 0
        with self._connect() as connection:
            self._begin(connection)
            rows = connection.execute(
                """SELECT j.*, c.claim_id, c.generation, c.route_id, c.effect_state,
                          c.lease_expires_at FROM jobs j JOIN claims c USING(job_id)
                   WHERE j.state IN ('DISPATCH_READY','RUNNING')
                     AND c.lease_expires_at IS NOT NULL AND c.lease_expires_at<=?
                   ORDER BY j.created_at, j.job_id""",
                (now,),
            ).fetchall()
            for row in rows:
                route: dict[str, object] | None = None
                if row["state"] == "DISPATCH_READY":
                    safe = True
                else:
                    try:
                        route = self._route_by_id(str(row["route_id"]))
                    except DispatcherError:
                        route = None
                    safe = bool(
                        route is not None
                        and route["read_only"] is True
                        and route["idempotent"] is True
                        and row["effect_state"] == "NO_EXTERNAL_EFFECT_PROVED"
                    )
                generation = int(row["generation"]) + 1
                if safe:
                    connection.execute(
                        """UPDATE jobs SET state='QUEUED', truth_state=?, assigned_route_id=NULL,
                             recoveries=recoveries+1, revision=revision+1, updated_at=? WHERE job_id=?""",
                        (TRUTH_ATTEMPTED if row["state"] == "RUNNING" else TRUTH_ACKNOWLEDGED, now, row["job_id"]),
                    )
                    connection.execute(
                        """UPDATE claims SET generation=?, worker_id=NULL, route_id=NULL,
                             phase='RECOVERED', effect_state='NOT_STARTED', lease_expires_at=NULL,
                             updated_at=? WHERE job_id=?""",
                        (generation, now, row["job_id"]),
                    )
                    self._append_event(connection, row["job_id"], "LEASE_RECOVERED", {
                        "previous_generation": int(row["generation"]),
                        "fence_generation": generation,
                        "previous_state": row["state"],
                        "state": "QUEUED",
                    })
                    recovered += 1
                else:
                    connection.execute(
                        "UPDATE jobs SET state='BLOCKED', truth_state=?, revision=revision+1, updated_at=? WHERE job_id=?",
                        (TRUTH_BLOCKED, now, row["job_id"]),
                    )
                    connection.execute(
                        "UPDATE claims SET generation=?, phase='BLOCKED_RECONCILE', lease_expires_at=NULL, updated_at=? WHERE job_id=?",
                        (generation, now, row["job_id"]),
                    )
                    receipt_sha = self._insert_terminal_receipt(
                        connection,
                        row["job_id"],
                        state="BLOCKED",
                        truth_state=TRUTH_BLOCKED,
                        error_code="AMBIGUOUS_OR_REMOVED_ROUTE",
                    )
                    self._append_event(connection, row["job_id"], "AMBIGUOUS_LEASE_BLOCKED", {
                        "previous_generation": int(row["generation"]),
                        "fence_generation": generation,
                        "effect_state": row["effect_state"],
                        "receipt_sha256": receipt_sha,
                        "state": "BLOCKED",
                        "truth_state": TRUTH_BLOCKED,
                    }, terminal=True)
                    blocked += 1
            connection.commit()
        return {"recovered": recovered, "blocked": blocked}

    def status(self, job_or_intent_id: str) -> dict[str, object]:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT j.*, c.claim_id, c.effect_key, c.generation, c.phase,
                          c.lease_expires_at FROM jobs j LEFT JOIN claims c USING(job_id)
                   WHERE j.job_id=? OR j.intent_id=?""",
                (job_or_intent_id, job_or_intent_id),
            ).fetchone()
        if row is None:
            raise DispatcherError("job not found", code="JOB_NOT_FOUND")
        return {
            "job_id": row["job_id"],
            "intent_id": row["intent_id"],
            "request_sha256": row["request_sha256"],
            "state": row["state"],
            "truth_state": row["truth_state"],
            "terminal": row["state"] in TERMINAL_STATES,
            "done": row["state"] == "VERIFIED" and row["truth_state"] == TRUTH_COMPLETE,
            "claim_id": row["claim_id"],
            "effect_key": row["effect_key"],
            "generation": row["generation"],
            "route_id": row["assigned_route_id"],
            "lease_expires_at": row["lease_expires_at"],
            "attempts": int(row["attempts"]),
            "recoveries": int(row["recoveries"]),
        }

    def terminal_readback(self, job_or_intent_id: str) -> dict[str, object]:
        status = self.status(job_or_intent_id)
        if status["state"] not in TERMINAL_STATES:
            return status
        with self._connect() as connection:
            row = connection.execute(
                """SELECT tr.*, j.intent_id, j.request_sha256, j.result_sha256,
                          j.state terminal_state, j.truth_state terminal_truth_state,
                          c.claim_id, c.effect_key,
                          (SELECT COUNT(*) FROM events e WHERE e.job_id=j.job_id AND e.terminal_unique=1) terminal_events
                   FROM terminal_receipts tr JOIN jobs j USING(job_id) JOIN claims c USING(job_id)
                   WHERE tr.job_id=?""",
                (status["job_id"],),
            ).fetchone()
        if row is None:
            raise DispatcherError("terminal receipt missing", code="TERMINAL_RECEIPT_MISSING")
        receipt = json.loads(row["receipt_json"])
        if canonical_hash(receipt) != row["receipt_sha256"]:
            raise DispatcherError("terminal receipt hash mismatch", code="TERMINAL_RECEIPT_CORRUPT")
        if not (
            receipt.get("job_id") == status["job_id"]
            and receipt.get("intent_id") == row["intent_id"]
            and receipt.get("request_sha256") == row["request_sha256"]
            and receipt.get("result_sha256") == row["result_sha256"]
            and receipt.get("claim_id") == row["claim_id"]
            and receipt.get("effect_key") == row["effect_key"]
            and receipt.get("state") == row["terminal_state"] == status["state"]
            and receipt.get("truth_state") == row["terminal_truth_state"] == status["truth_state"]
            and receipt.get("terminal_readback_verified") is (status["state"] == "VERIFIED")
            and int(row["terminal_events"]) == 1
        ):
            raise DispatcherError("terminal receipt binding mismatch", code="TERMINAL_BINDING_MISMATCH")
        return {
            **status,
            "terminal": True,
            "succeeded": status["state"] == "VERIFIED",
            "done": status["state"] == "VERIFIED" and status["truth_state"] == TRUTH_COMPLETE,
            "receipt_sha256": row["receipt_sha256"],
            "result_sha256": row["result_sha256"],
            "terminal_readback_verified": True,
        }

    def integrity(self) -> dict[str, object]:
        with self._connect() as connection:
            check = connection.execute("PRAGMA integrity_check").fetchone()[0]
            counts = {
                table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                for table in ("jobs", "claims", "attempts", "results", "events", "terminal_receipts")
            }
            jobs = connection.execute("SELECT job_id FROM jobs ORDER BY job_id").fetchall()
            for job in jobs:
                events = connection.execute(
                    "SELECT * FROM events WHERE job_id=? ORDER BY seq", (job["job_id"],)
                ).fetchall()
                previous = None
                for expected_seq, event in enumerate(events, start=1):
                    material = {
                        "job_id": event["job_id"],
                        "seq": expected_seq,
                        "kind": event["kind"],
                        "payload": json.loads(event["payload_json"]),
                        "previous_sha256": previous,
                        "created_at": float(event["created_at"]),
                    }
                    if int(event["seq"]) != expected_seq or event["previous_sha256"] != previous or event["event_sha256"] != canonical_hash(material):
                        raise DispatcherError("event hash chain is corrupt", code="EVENT_CHAIN_CORRUPT")
                    previous = event["event_sha256"]
        if check != "ok":
            raise DispatcherError("SQLite integrity check failed", code="SQLITE_INTEGRITY_FAILED")
        return {"schema_version": SCHEMA_VERSION, "integrity_check": check, "counts": counts}

    def checkpoint(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def attempt_rows(self, job_id: str) -> list[dict[str, object]]:
        with self._connect() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT * FROM attempts WHERE job_id=? ORDER BY attempt_id", (job_id,)
            ).fetchall()]

    def event_rows(self, job_id: str) -> list[dict[str, object]]:
        with self._connect() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT * FROM events WHERE job_id=? ORDER BY seq", (job_id,)
            ).fetchall()]
