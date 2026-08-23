from __future__ import annotations

import copy
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping, Protocol

from jarvis.cenemy_pr_smm import CenemyOperatingBundle
from jarvis.chat_session_recovery import ChatSessionRecoveryPolicy


VERIFIED_DONE = "VERIFIED_DONE"


class Worker(Protocol):
    def __call__(self, mission: Mapping[str, object]) -> Mapping[str, object]: ...


class SyntheticTransientError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _stable_mission_id(
    project: str,
    objective: str,
    source_refs: Iterable[str],
) -> str:
    refs = sorted({str(ref).strip() for ref in source_refs if str(ref).strip()})
    material = json.dumps(
        {"project": project, "objective": objective.strip(), "source_refs": refs},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "MISSION-" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:20].upper()


def _append_event(state: dict[str, object], event_type: str, **details: object) -> None:
    events = state.setdefault("events", [])
    if not isinstance(events, list):
        raise ValueError("events must be a list")
    event: dict[str, object] = {
        "sequence": len(events) + 1,
        "at": _now(),
        "event_type": event_type,
    }
    if details:
        event["details"] = details
    events.append(event)


def _task(state: dict[str, object]) -> dict[str, object]:
    tasks = state.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != 1 or not isinstance(tasks[0], dict):
        raise ValueError("synthetic mission requires exactly one task")
    return tasks[0]


@dataclass(frozen=True, slots=True)
class CanarySuiteResult:
    status: str
    passed: int
    requested: int
    user_orchestration_touches: int
    runs: tuple[dict[str, object], ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "passed": self.passed,
            "requested": self.requested,
            "user_orchestration_touches": self.user_orchestration_touches,
            "runs": [copy.deepcopy(run) for run in self.runs],
        }


class MissionStore:
    """Small durable contract fixture; it is not a production queue."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.missions = self.root / "missions"
        self.missions.mkdir(parents=True, exist_ok=True)

    def path(self, mission_id: str) -> Path:
        return self.missions / f"{mission_id}.json"

    def load(self, mission_id: str) -> dict[str, object]:
        raw = json.loads(self.path(mission_id).read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("mission state must be an object")
        return raw

    def save(self, state: Mapping[str, object]) -> dict[str, object]:
        saved = copy.deepcopy(dict(state))
        mission_id = saved.get("mission_id")
        if not isinstance(mission_id, str) or not mission_id:
            raise ValueError("mission state requires mission_id")
        revision = saved.get("revision", 0)
        if isinstance(revision, bool) or not isinstance(revision, int):
            raise ValueError("mission revision must be integer")
        saved["revision"] = revision + 1
        saved["updated_at"] = _now()
        target = self.path(mission_id)
        temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        payload = json.dumps(saved, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        with temp.open("w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, target)
        return saved

    def submit(
        self,
        *,
        bundle: CenemyOperatingBundle,
        objective: str,
        source_refs: Iterable[str] = (),
    ) -> dict[str, object]:
        if not isinstance(objective, str) or not objective.strip():
            raise ValueError("objective must be non-empty")
        refs = sorted({str(ref).strip() for ref in source_refs if str(ref).strip()})
        mission_id = _stable_mission_id(bundle.project, objective, refs)
        target = self.path(mission_id)
        if target.exists():
            state = self.load(mission_id)
            telemetry = state.get("telemetry")
            if not isinstance(telemetry, dict):
                raise ValueError("mission telemetry must be an object")
            telemetry["duplicate_submissions"] = int(
                telemetry.get("duplicate_submissions", 0)
            ) + 1
            _append_event(state, "DUPLICATE_SUBMISSION_DEDUPED")
            return self.save(state)

        state: dict[str, object] = {
            "schema_version": "SANITIZED_MISSION_FIXTURE_V1",
            "mission_id": mission_id,
            "project": bundle.project,
            "objective": objective.strip(),
            "source_refs": refs,
            "status": "PENDING",
            "attempt": 0,
            "revision": 0,
            "tasks": [
                {
                    "task_id": f"{mission_id}-TASK-1",
                    "status": "PENDING",
                }
            ],
            "events": [],
            "telemetry": {
                "duplicate_submissions": 0,
                "transport_recoveries": 0,
                "user_orchestration_touches": 0,
                "main_manual_dispatches": 0,
                "external_effect_count": 0,
            },
            "checkpoint": {
                "revision": 1,
                "stage": "INTAKE_PERSISTED",
                "at": _now(),
            },
            "created_at": _now(),
        }
        _append_event(state, "MISSION_ACCEPTED")
        return self.save(state)


@dataclass(slots=True)
class DeterministicStaleSafeWorker:
    fail_first_attempt: bool = True

    def __call__(self, mission: Mapping[str, object]) -> Mapping[str, object]:
        attempt = mission.get("attempt")
        if isinstance(attempt, bool) or not isinstance(attempt, int):
            raise ValueError("mission attempt must be integer")
        if self.fail_first_attempt and attempt == 1:
            raise SyntheticTransientError("injected transport interruption")
        mission_id = mission.get("mission_id")
        if not isinstance(mission_id, str) or not mission_id:
            raise ValueError("mission_id missing")
        return {
            "status": "WORKER_RESULT",
            "mission_id": mission_id,
            "evidence_refs": [f"synthetic://{mission_id}/attempt-{attempt}"],
            "external_side_effects": False,
        }


def run_mission(
    store: MissionStore,
    mission_id: str,
    *,
    worker: Worker,
    recovery_policy: ChatSessionRecoveryPolicy,
    max_attempts: int = 3,
) -> dict[str, object]:
    if max_attempts < 1:
        raise ValueError("max_attempts must be >= 1")
    if recovery_policy.user_retry_required:
        raise ValueError("synthetic recovery policy cannot require user retry")
    state = store.load(mission_id)
    if state.get("status") == "SUCCEEDED":
        return state

    while int(state.get("attempt", 0)) < max_attempts:
        state["attempt"] = int(state.get("attempt", 0)) + 1
        state["status"] = "RUNNING"
        _task(state)["status"] = "RUNNING"
        state["checkpoint"] = {
            "revision": int(state["attempt"]),
            "stage": "WORKER_ATTEMPT_STARTED",
            "at": _now(),
        }
        _append_event(
            state,
            "WORKER_ATTEMPT_STARTED",
            attempt=state["attempt"],
        )
        state = store.save(state)
        try:
            result = worker(copy.deepcopy(state))
        except SyntheticTransientError as exc:
            telemetry = state.get("telemetry")
            if not isinstance(telemetry, dict):
                raise ValueError("mission telemetry must be an object")
            telemetry["transport_recoveries"] = int(
                telemetry.get("transport_recoveries", 0)
            ) + 1
            state["status"] = "RECOVERING"
            _task(state)["status"] = "PENDING"
            state["checkpoint"] = {
                "revision": int(state["attempt"]),
                "stage": "TRANSPORT_INTERRUPTED_CHECKPOINTED",
                "at": _now(),
                "details": {"error": str(exc), "user_retry_required": False},
            }
            _append_event(
                state,
                "TRANSPORT_RECOVERED_AUTOMATICALLY",
                attempt=state["attempt"],
                user_retry_required=False,
            )
            state = store.save(state)
            continue
        except Exception as exc:
            state["status"] = "FAILED"
            _task(state)["status"] = "FAILED"
            state["terminal_readback"] = {
                "status": "FAILED",
                "mission_id": mission_id,
                "error_type": type(exc).__name__,
                "error": str(exc),
            }
            _append_event(state, "WORKER_FAILED", error=str(exc))
            return store.save(state)

        state["result"] = copy.deepcopy(dict(result))
        state["status"] = "SUCCEEDED"
        _task(state)["status"] = "SUCCEEDED"
        state["terminal_readback"] = {
            "status": VERIFIED_DONE,
            "mission_id": mission_id,
            "attempt": state["attempt"],
        }
        state["checkpoint"] = {
            "revision": int(state["attempt"]),
            "stage": VERIFIED_DONE,
            "at": _now(),
        }
        _append_event(
            state,
            VERIFIED_DONE,
            attempt=state["attempt"],
            user_retry_required=False,
        )
        return store.save(state)

    state["status"] = "FAILED"
    _task(state)["status"] = "FAILED"
    state["terminal_readback"] = {
        "status": "FAILED",
        "mission_id": mission_id,
        "reason": "MAX_ATTEMPTS_EXHAUSTED",
    }
    _append_event(state, "MAX_ATTEMPTS_EXHAUSTED", user_retry_required=False)
    return store.save(state)
