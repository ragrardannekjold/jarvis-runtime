#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

STATE_BRANCH = "jarvis-runtime-state"
SNAPSHOT_PATH = "runtime/chat-recovery/latest.json"
HEARTBEAT_PATH = "runtime/public-runtime-heartbeat.json"


class ReportError(RuntimeError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _request(
    url: str,
    token: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[int, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "jarvis-main-daily-report/1.0",
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


def _content_url(repo: str, path: str, ref: str | None = None) -> str:
    encoded_path = urllib.parse.quote(path, safe="/")
    base = f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
    if ref is None:
        return base
    return f"{base}?ref={urllib.parse.quote(ref)}"


def _read_private_text(
    repo: str,
    token: str,
    path: str,
    *,
    ref: str = STATE_BRANCH,
    missing_ok: bool = False,
) -> tuple[str | None, str | None]:
    status, payload = _request(_content_url(repo, path, ref), token)
    if status == 404 and missing_ok:
        return None, None
    if status != 200 or not isinstance(payload, dict):
        raise ReportError(f"private read failed for {path}: HTTP {status}")
    encoded = payload.get("content")
    sha = payload.get("sha")
    if not isinstance(encoded, str) or not isinstance(sha, str):
        raise ReportError(f"private read payload invalid for {path}")
    try:
        text = base64.b64decode(encoded).decode("utf-8")
    except Exception as exc:
        raise ReportError(f"private content decode failed for {path}") from exc
    return text, sha


def _read_private_json(repo: str, token: str, path: str) -> dict[str, Any]:
    text, _sha = _read_private_text(repo, token, path)
    try:
        payload = json.loads(text or "")
    except json.JSONDecodeError as exc:
        raise ReportError(f"invalid JSON in private state {path}") from exc
    if not isinstance(payload, dict):
        raise ReportError(f"private state {path} must be an object")
    return payload


def _write_private_text_with_readback(
    repo: str,
    token: str,
    path: str,
    content: str,
    *,
    message: str,
) -> str:
    _current, current_sha = _read_private_text(
        repo, token, path, missing_ok=True
    )
    body: dict[str, Any] = {
        "message": message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": STATE_BRANCH,
    }
    if current_sha:
        body["sha"] = current_sha
    status, _payload = _request(
        _content_url(repo, path), token, method="PUT", payload=body
    )
    if status not in {200, 201}:
        raise ReportError(f"private write failed for {path}: HTTP {status}")
    readback, _readback_sha = _read_private_text(repo, token, path)
    if readback != content:
        raise ReportError(f"private readback mismatch for {path}")
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def _age_minutes(value: object, now: datetime) -> float | None:
    parsed = _parse_datetime(value)
    if parsed is None:
        return None
    return max(0.0, (now.astimezone(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds() / 60.0)


def _extract(pattern: str, text: str, default: str = "UNKNOWN") -> str:
    match = re.search(pattern, text, flags=re.MULTILINE)
    return match.group(1).strip() if match else default


def _section(text: str, title: str) -> str:
    marker = f"## {title}"
    start = text.find(marker)
    if start < 0:
        return ""
    body_start = start + len(marker)
    next_heading = text.find("\n## ", body_start)
    return text[body_start:] if next_heading < 0 else text[body_start:next_heading]


def _load_policy(command_center: Path) -> tuple[dict[str, Any], str]:
    path = command_center / "config/daily_control_report.json"
    raw = path.read_bytes()
    try:
        policy = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ReportError("daily report policy is invalid JSON") from exc
    if not isinstance(policy, dict):
        raise ReportError("daily report policy must be an object")
    required_sections = policy.get("required_sections")
    expected = {
        "verified_work_completed",
        "decisions_taken",
        "blockers_and_risks",
        "next_system_actions",
        "user_action_marker",
    }
    if policy.get("logical_control_chat") != "main":
        raise ReportError("daily report policy is not bound to main")
    if policy.get("timezone") != "Europe/Kyiv":
        raise ReportError("daily report timezone drifted")
    if policy.get("report_label_local_time") != "20:00":
        raise ReportError("daily report label drifted from 20:00")
    if not isinstance(required_sections, list) or set(required_sections) != expected:
        raise ReportError("daily report required sections drifted")
    content_rules = policy.get("content_rules")
    if not isinstance(content_rules, dict):
        raise ReportError("daily report content rules missing")
    mandatory_true = {
        "single_consolidated_report",
        "per_process_routine_reports_forbidden",
        "technical_activity_is_not_business_result",
        "business_progress_is_not_revenue",
        "revenue_requires_credited_spendable_evidence",
        "unknown_or_stale_state_must_be_labeled",
        "user_action_only_for_active_irreducible_gate",
        "tables_forbidden_in_human_report",
    }
    if any(content_rules.get(key) is not True for key in mandatory_true):
        raise ReportError("daily report evidence rules are not enforced")
    delivery = policy.get("delivery_boundary")
    if not isinstance(delivery, dict):
        raise ReportError("daily report delivery boundary missing")
    if delivery.get("automatic_chat_push_available") is not False:
        raise ReportError("false automatic ChatGPT delivery claim")
    if delivery.get("automatic_google_drive_update_available") is not False:
        raise ReportError("false automatic Google Drive delivery claim")
    return policy, hashlib.sha256(raw).hexdigest()


def _validate_authority(snapshot: dict[str, Any]) -> dict[str, Any]:
    control = snapshot.get("control_chat_authority")
    if not isinstance(control, dict):
        raise ReportError("recovery snapshot missing control_chat_authority")
    if control.get("logical_name") != "main" or control.get("status") != "ACTIVE_CANONICAL":
        raise ReportError("recovery snapshot does not confirm active canonical main")
    authority = control.get("authority")
    binding = control.get("binding")
    if not isinstance(authority, dict) or not isinstance(binding, dict):
        raise ReportError("canonical main authority payload is incomplete")
    if authority.get("canonical_control_chat_count") != 1:
        raise ReportError("recovery snapshot contains split control authority")
    if authority.get("parallel_control_centers_forbidden") is not True:
        raise ReportError("parallel control centers are not forbidden")
    if authority.get("archive_chats_may_issue_system_changes") is not False:
        raise ReportError("archive chat write authority is enabled")
    if binding.get("predecessor_role") != "ARCHIVE_CONTEXT_ONLY":
        raise ReportError("predecessor chat is not archive-only")
    authority_sha = control.get("authority_sha256")
    if not isinstance(authority_sha, str) or len(authority_sha) != 64:
        raise ReportError("canonical main authority SHA is missing")
    return control


def _parse_checkpoint(command_center: Path) -> dict[str, Any]:
    text = (command_center / "checkpoints/CURRENT_CHECKPOINT.md").read_text(encoding="utf-8")
    commercial = _section(text, "Current stable commercial mode")
    primary = _section(text, "Primary WIP")
    revenue_raw = _extract(
        r"Current recognized revenue remains \*\*([0-9]+(?:[.,][0-9]+)?)\*\*",
        text,
        "0",
    )
    try:
        revenue_amount = float(revenue_raw.replace(",", "."))
    except ValueError:
        revenue_amount = 0.0
    if revenue_amount.is_integer():
        revenue_amount = int(revenue_amount)
    return {
        "checkpoint_timestamp": _extract(r"^\*\*Timestamp:\*\*\s*(.+?)(?:\s{2}|$)", text),
        "checkpoint_version": _extract(r"^\*\*Checkpoint version:\*\*\s*(.+?)(?:\s{2}|$)", text),
        "recovery_generation": _extract(r"^\*\*Recovery generation:\*\*\s*(.+?)(?:\s{2}|$)", text),
        "system_health": _extract(r"^\*\*System health:\*\*\s*`([^`]+)`", text),
        "commercial_state": _extract(r"^\*\*State:\*\*\s*`([^`]+)`", commercial),
        "primary_wip": _extract(r"\*\*(.+?)\*\*", primary),
        "primary_wip_state": _extract(r"^\*\*State:\*\*\s*`([^`]+)`", primary),
        "recognized_revenue": {
            "amount": revenue_amount,
            "status": (
                "ZERO_NO_CREDITED_SPENDABLE_EVIDENCE"
                if revenue_amount == 0
                else "CHECKPOINT_RECOGNIZED_CREDITED_SPENDABLE"
            ),
            "evidence_source": "checkpoints/CURRENT_CHECKPOINT.md",
        },
    }


def _load_tasks(command_center: Path) -> list[dict[str, str]]:
    path = command_center / "registry/MASTER_TASK_REGISTRY.csv"
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def _load_accepted_results(
    command_center: Path, local_date: str, tz: ZoneInfo
) -> list[dict[str, Any]]:
    records_dir = command_center / "archive/results/records"
    accepted: list[dict[str, Any]] = []
    if not records_dir.is_dir():
        return accepted
    for path in sorted(records_dir.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict):
            continue
        occurred = _parse_datetime(record.get("occurred_at"))
        acceptance = record.get("acceptance")
        if occurred is None or occurred.astimezone(tz).date().isoformat() != local_date:
            continue
        if record.get("status") != "SUCCEEDED":
            continue
        if not isinstance(acceptance, dict) or acceptance.get("outcome") != "PASSED":
            continue
        accepted.append(
            {
                "result_id": record.get("result_id"),
                "task_id": record.get("task_id"),
                "project_id": record.get("project_id"),
                "summary": record.get("summary"),
                "occurred_at": record.get("occurred_at"),
                "result_class": (
                    "TECHNICAL_CONTROL"
                    if record.get("project_id") == "JCC"
                    else "PROJECT_OR_BUSINESS"
                ),
                "evidence_count": len(record.get("evidence", []))
                if isinstance(record.get("evidence"), list)
                else 0,
            }
        )
    return accepted


def _today_commits(
    command_center: Path, local_date: str, tz: ZoneInfo
) -> list[dict[str, str]]:
    start_local = datetime.combine(
        datetime.fromisoformat(local_date).date(), time.min, tzinfo=tz
    )
    end_local = datetime.combine(
        datetime.fromisoformat(local_date).date(), time.max, tzinfo=tz
    )
    command = [
        "git",
        "-C",
        str(command_center),
        "log",
        f"--since={start_local.astimezone(timezone.utc).isoformat()}",
        f"--until={end_local.astimezone(timezone.utc).isoformat()}",
        "--format=%H%x1f%cI%x1f%s",
        "--max-count=20",
        "main",
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        return []
    decisions: list[dict[str, str]] = []
    for line in completed.stdout.splitlines():
        parts = line.split("\x1f", 2)
        if len(parts) != 3:
            continue
        sha, committed_at, subject = parts
        decisions.append(
            {
                "commit": sha[:12],
                "committed_at": committed_at,
                "decision": subject.strip(),
                "classification": "DURABLE_MAIN_BRANCH_CHANGE",
            }
        )
    return decisions


def _active_user_actions(tasks: list[dict[str, str]]) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    for row in tasks:
        if row.get("user_action_required", "").strip().lower() != "true":
            continue
        if row.get("primary_wip", "").strip().lower() != "true":
            continue
        if row.get("status") != "BLOCKED":
            continue
        actions.append(
            {
                "task_id": row.get("task_id", ""),
                "project_id": row.get("project_id", ""),
                "title": row.get("title", ""),
                "blocked_by": row.get("blocked_by", ""),
                "required_action": row.get("next_action", ""),
            }
        )
    return actions


def _source_freshness(
    snapshot: dict[str, Any],
    heartbeat: dict[str, Any],
    policy: dict[str, Any],
    now: datetime,
) -> dict[str, Any]:
    requirements = policy.get("source_requirements", {})
    snapshot_limit = int(requirements.get("snapshot_max_age_minutes", 90))
    heartbeat_limit = int(requirements.get("heartbeat_max_age_minutes", 90))
    snapshot_age = _age_minutes(snapshot.get("generated_utc"), now)
    heartbeat_age = _age_minutes(heartbeat.get("generated_utc"), now)
    return {
        "snapshot": {
            "generated_utc": snapshot.get("generated_utc"),
            "age_minutes": round(snapshot_age, 1) if snapshot_age is not None else None,
            "max_age_minutes": snapshot_limit,
            "fresh": snapshot_age is not None and snapshot_age <= snapshot_limit,
        },
        "heartbeat": {
            "generated_utc": heartbeat.get("generated_utc"),
            "age_minutes": round(heartbeat_age, 1) if heartbeat_age is not None else None,
            "max_age_minutes": heartbeat_limit,
            "fresh": heartbeat_age is not None and heartbeat_age <= heartbeat_limit,
            "status": heartbeat.get("status"),
        },
    }


def _build_report(
    *,
    command_center: Path,
    policy: dict[str, Any],
    policy_sha: str,
    snapshot: dict[str, Any],
    heartbeat: dict[str, Any],
    now: datetime,
    mode: str,
) -> dict[str, Any]:
    tz = ZoneInfo(policy["timezone"])
    now_local = now.astimezone(tz)
    local_date = now_local.date().isoformat()
    control = _validate_authority(snapshot)
    checkpoint = _parse_checkpoint(command_center)
    tasks = _load_tasks(command_center)
    accepted_results = _load_accepted_results(command_center, local_date, tz)
    decisions = _today_commits(command_center, local_date, tz)
    freshness = _source_freshness(snapshot, heartbeat, policy, now)

    verified_work: list[dict[str, Any]] = [
        {
            "class": "TECHNICAL_CONTROL",
            "summary": "Єдиний канонічний чат main підтверджено приватним recovery readback.",
            "evidence": {
                "authority_sha256": control.get("authority_sha256"),
                "snapshot_generated_utc": snapshot.get("generated_utc"),
            },
        }
    ]

    checks = heartbeat.get("control_plane_checks")
    if isinstance(checks, list):
        passed = sum(
            1 for item in checks if isinstance(item, dict) and item.get("status") == "PASS"
        )
        verified_work.append(
            {
                "class": "TECHNICAL_CONTROL",
                "summary": f"Контрольний runtime: {passed}/{len(checks)} перевірок PASS.",
                "evidence": {
                    "heartbeat_generated_utc": heartbeat.get("generated_utc"),
                    "heartbeat_status": heartbeat.get("status"),
                },
            }
        )

    for result in accepted_results:
        verified_work.append(
            {
                "class": result["result_class"],
                "summary": result.get("summary") or result.get("result_id"),
                "evidence": {
                    "result_id": result.get("result_id"),
                    "task_id": result.get("task_id"),
                    "occurred_at": result.get("occurred_at"),
                    "evidence_count": result.get("evidence_count"),
                },
            }
        )

    blockers: list[dict[str, Any]] = []
    if not freshness["snapshot"]["fresh"]:
        blockers.append(
            {
                "severity": "HIGH",
                "code": "STALE_RECOVERY_SNAPSHOT",
                "summary": "Приватний recovery snapshot прострочений або має невідому давність.",
            }
        )
    if not freshness["heartbeat"]["fresh"] or heartbeat.get("status") != "PASS":
        blockers.append(
            {
                "severity": "HIGH",
                "code": "RUNTIME_HEARTBEAT_NOT_FRESH_PASS",
                "summary": "Runtime heartbeat не є свіжим підтвердженим PASS.",
            }
        )
    if "DEGRADED" in str(checkpoint.get("system_health", "")):
        blockers.append(
            {
                "severity": "HIGH",
                "code": "GLOBAL_SYSTEM_DEGRADED",
                "summary": str(checkpoint.get("system_health")),
            }
        )
    if "DEGRADED" in str(checkpoint.get("commercial_state", "")):
        blockers.append(
            {
                "severity": "HIGH",
                "code": "COMMERCIAL_CONVERSION_DEGRADED",
                "summary": str(checkpoint.get("commercial_state")),
            }
        )

    oversight = snapshot.get("oversight")
    if isinstance(oversight, dict):
        urgent = oversight.get("urgent_findings")
        if isinstance(urgent, list):
            for finding in urgent[:5]:
                if isinstance(finding, dict):
                    blockers.append(
                        {
                            "severity": finding.get("severity", "HIGH"),
                            "code": finding.get("code", "URGENT_FINDING"),
                            "summary": finding.get("summary", "Urgent oversight finding"),
                            "task_ids": finding.get("task_ids", []),
                        }
                    )
        watchlist = oversight.get("watchlist")
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        if isinstance(watchlist, list):
            for finding in watchlist:
                if isinstance(finding, dict):
                    grouped[str(finding.get("code", "WATCH"))].append(finding)
        for code, findings in sorted(grouped.items()):
            task_ids: list[str] = []
            for finding in findings:
                raw_ids = finding.get("task_ids")
                if isinstance(raw_ids, list):
                    task_ids.extend(str(item) for item in raw_ids)
            blockers.append(
                {
                    "severity": "WARN",
                    "code": code,
                    "summary": f"{len(findings)} однотипних попереджень консолідовано.",
                    "task_ids": sorted(set(task_ids)),
                }
            )

    revenue = checkpoint["recognized_revenue"]
    if revenue.get("amount") == 0:
        blockers.append(
            {
                "severity": "HIGH",
                "code": "NO_CREDITED_SPENDABLE_REVENUE",
                "summary": "Підтверджений зарахований і доступний до витрат дохід залишається 0.",
            }
        )

    next_actions: list[dict[str, str]] = []
    seen_actions: set[str] = set()
    top_dispatch = snapshot.get("top_dispatch")
    if isinstance(top_dispatch, dict):
        action = str(top_dispatch.get("next_action", "")).strip()
        if action:
            next_actions.append(
                {
                    "source": "top_dispatch",
                    "task_id": str(top_dispatch.get("task_id", "")),
                    "project_id": str(top_dispatch.get("project_id", "")),
                    "action": action,
                }
            )
            seen_actions.add(action)
    for row in tasks:
        if row.get("primary_wip", "").lower() != "true":
            continue
        if row.get("status") not in {"READY", "IN_PROGRESS", "BLOCKED"}:
            continue
        action = row.get("next_action", "").strip()
        if not action or action in seen_actions:
            continue
        next_actions.append(
            {
                "source": "primary_wip",
                "task_id": row.get("task_id", ""),
                "project_id": row.get("project_id", ""),
                "action": action,
            }
        )
        seen_actions.add(action)
        if len(next_actions) >= 5:
            break

    user_actions = _active_user_actions(tasks)
    report_id = (
        f"main-{local_date}-{policy_sha[:8]}-"
        f"{str(control.get('authority_sha256'))[:8]}"
    )
    return {
        "schema_version": 1,
        "report_id": report_id,
        "status": {
            "final": "FINAL",
            "verification": "VERIFICATION_ONLY",
            "dry-run": "DRY_RUN",
        }[mode],
        "report_date_local": local_date,
        "report_label_local_time": policy["report_label_local_time"],
        "generated_utc": now.astimezone(timezone.utc).isoformat(),
        "generated_local": now_local.isoformat(),
        "timezone": policy["timezone"],
        "control_chat": {
            "logical_name": "main",
            "authority_sha256": control.get("authority_sha256"),
            "authority_version": control.get("authority_version"),
            "predecessor_role": control.get("binding", {}).get("predecessor_role")
            if isinstance(control.get("binding"), dict)
            else None,
        },
        "policy": {
            "version": policy.get("version"),
            "sha256": policy_sha,
        },
        "system_state": checkpoint,
        "source_freshness": freshness,
        "financial_result": revenue,
        "sections": {
            "verified_work_completed": verified_work,
            "decisions_taken": decisions,
            "blockers_and_risks": blockers,
            "next_system_actions": next_actions,
            "user_action_marker": {
                "required": bool(user_actions),
                "count": len(user_actions),
                "actions": user_actions,
                "summary": (
                    "Потрібна лише наведена активна user-only дія."
                    if user_actions
                    else "Дія користувача зараз не потрібна."
                ),
            },
        },
        "counts": {
            "verified_work": len(verified_work),
            "durable_decisions": len(decisions),
            "blockers_and_risks": len(blockers),
            "next_actions": len(next_actions),
            "user_actions": len(user_actions),
        },
        "delivery_boundary": policy.get("delivery_boundary"),
        "persistence": {
            "state_branch": STATE_BRANCH,
            "readback_pending": mode != "dry-run",
            "readback_verified_utc": None,
        },
    }


def _render_markdown(report: dict[str, Any]) -> str:
    sections = report["sections"]
    state = report["system_state"]
    revenue = report["financial_result"]
    lines = [
        "# main — щоденний звіт 20:00",
        "",
        f"**Дата:** {report['report_date_local']}  ",
        f"**Стан системи:** `{state.get('system_health', 'UNKNOWN')}`  ",
        f"**Комерційний стан:** `{state.get('commercial_state', 'UNKNOWN')}`  ",
        f"**Підтверджений credited-spendable дохід:** **{revenue.get('amount', 0)}**  ",
        f"**Звіт:** `{report['status']}` / `{report['report_id']}`",
        "",
        "## 1. Що підтверджено зроблено",
        "",
    ]
    verified = sections["verified_work_completed"]
    if verified:
        for item in verified:
            lines.append(f"- **{item.get('class', 'RESULT')}:** {item.get('summary', '')}")
    else:
        lines.append("- За цю дату немає результату з достатнім доказом приймання.")

    lines.extend(["", "## 2. Прийняті рішення", ""])
    decisions = sections["decisions_taken"]
    if decisions:
        for item in decisions[:8]:
            lines.append(
                f"- `{item.get('commit', '')}` — {item.get('decision', '')}"
            )
    else:
        lines.append("- Нових довготривалих рішень у `main` за цю дату не зафіксовано.")

    lines.extend(["", "## 3. Блокери та ризики", ""])
    blockers = sections["blockers_and_risks"]
    if blockers:
        for item in blockers[:10]:
            task_ids = item.get("task_ids")
            suffix = (
                f" Завдання: {', '.join(task_ids)}."
                if isinstance(task_ids, list) and task_ids
                else ""
            )
            lines.append(
                f"- **{item.get('severity', 'WARN')} / {item.get('code', 'RISK')}:** "
                f"{item.get('summary', '')}{suffix}"
            )
    else:
        lines.append("- Матеріальних блокерів або ризиків не виявлено.")

    lines.extend(["", "## 4. Що система робить далі", ""])
    next_actions = sections["next_system_actions"]
    if next_actions:
        for item in next_actions[:5]:
            lines.append(
                f"- **{item.get('task_id', '')}:** {item.get('action', '')}"
            )
    else:
        lines.append("- Немає безпечно підтвердженої наступної дії; потрібне відновлення стану.")

    user_marker = sections["user_action_marker"]
    lines.extend(["", "## 5. Чи потрібна дія користувача", ""])
    lines.append(f"- **{user_marker.get('summary', '')}**")
    for item in user_marker.get("actions", [])[:3]:
        lines.append(
            f"- `{item.get('task_id', '')}` — {item.get('required_action', '')}"
        )

    freshness = report["source_freshness"]
    lines.extend(
        [
            "",
            "## Достовірність",
            "",
            f"- Recovery snapshot: {freshness['snapshot'].get('age_minutes')} хв; fresh={freshness['snapshot'].get('fresh')}.",
            f"- Runtime heartbeat: {freshness['heartbeat'].get('age_minutes')} хв; fresh={freshness['heartbeat'].get('fresh')}; status={freshness['heartbeat'].get('status')}.",
            f"- Authority SHA: `{report['control_chat'].get('authority_sha256')}`.",
            f"- Policy SHA: `{report['policy'].get('sha256')}`.",
            "- Автоматична відправка в ChatGPT або Google Drive не заявляється без окремого перевіреного мосту.",
            "",
        ]
    )
    return "\n".join(lines)


def _existing_final_report(
    repo: str, token: str, path: str, local_date: str
) -> dict[str, Any] | None:
    text, _sha = _read_private_text(repo, token, path, missing_ok=True)
    if text is None:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    persistence = payload.get("persistence")
    if (
        payload.get("status") == "FINAL"
        and payload.get("report_date_local") == local_date
        and isinstance(persistence, dict)
        and persistence.get("readback_pending") is False
        and isinstance(persistence.get("readback_verified_utc"), str)
    ):
        return payload
    return None


def _persist_report(
    *,
    repo: str,
    token: str,
    report: dict[str, Any],
    markdown: str,
    policy: dict[str, Any],
    mode: str,
) -> None:
    local_date = report["report_date_local"]
    if mode == "final":
        output = policy["durable_output"]
        json_path = str(output["daily_json_template"]).format(local_date=local_date)
        markdown_path = str(output["daily_markdown_template"]).format(local_date=local_date)
        current_path = str(output["current_markdown_path"])
    elif mode == "verification":
        json_path = "runtime/daily-report/verification/latest.json"
        markdown_path = "runtime/daily-report/verification/latest.md"
        current_path = None
    else:
        return

    markdown_sha = _write_private_text_with_readback(
        repo,
        token,
        markdown_path,
        markdown,
        message=f"{mode} main daily report markdown {report['report_id']}",
    )
    if current_path:
        _write_private_text_with_readback(
            repo,
            token,
            current_path,
            markdown,
            message=f"update current main daily report {report['report_id']}",
        )

    report["persistence"].update(
        {
            "json_path": json_path,
            "markdown_path": markdown_path,
            "current_markdown_path": current_path,
            "markdown_sha256": markdown_sha,
        }
    )
    pending_json = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    _write_private_text_with_readback(
        repo,
        token,
        json_path,
        pending_json,
        message=f"stage {mode} main daily report {report['report_id']}",
    )

    report["persistence"]["readback_pending"] = False
    report["persistence"]["readback_verified_utc"] = utc_now().isoformat()
    final_json = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    _write_private_text_with_readback(
        repo,
        token,
        json_path,
        final_json,
        message=f"finalize {mode} main daily report {report['report_id']}",
    )
    readback, _sha = _read_private_text(repo, token, json_path)
    verified = json.loads(readback or "")
    if not isinstance(verified, dict):
        raise ReportError("final daily report readback is not an object")
    if verified.get("report_id") != report.get("report_id"):
        raise ReportError("final daily report readback id mismatch")
    if verified.get("policy", {}).get("sha256") != report.get("policy", {}).get("sha256"):
        raise ReportError("final daily report policy SHA mismatch")
    if verified.get("control_chat", {}).get("authority_sha256") != report.get("control_chat", {}).get("authority_sha256"):
        raise ReportError("final daily report authority SHA mismatch")
    if verified.get("persistence", {}).get("readback_pending") is not False:
        raise ReportError("final daily report readback remains pending")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--command-center", default="command-center")
    parser.add_argument(
        "--mode", choices=("final", "verification", "dry-run"), default="dry-run"
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--now", help="timezone-aware ISO timestamp for deterministic tests")
    args = parser.parse_args()

    command_center = Path(args.command_center).resolve()
    repo = os.environ.get("COMMAND_CENTER_REPO", "").strip()
    token = os.environ.get("COMMAND_CENTER_TOKEN", "").strip()
    if not repo or not token:
        print("DAILY_REPORT_BRIDGE_NOT_CONFIGURED")
        return 2

    try:
        policy, policy_sha = _load_policy(command_center)
        now = _parse_datetime(args.now) if args.now else utc_now()
        if now is None:
            raise ReportError("--now must be a timezone-aware ISO timestamp")
        tz = ZoneInfo(policy["timezone"])
        local_date = now.astimezone(tz).date().isoformat()
        if args.mode == "final":
            daily_json_path = str(policy["durable_output"]["daily_json_template"]).format(
                local_date=local_date
            )
            if not args.force:
                existing = _existing_final_report(repo, token, daily_json_path, local_date)
                if existing is not None:
                    print(f"DAILY_REPORT_ALREADY_FINAL:{existing.get('report_id')}")
                    return 0
        snapshot = _read_private_json(repo, token, SNAPSHOT_PATH)
        heartbeat = _read_private_json(repo, token, HEARTBEAT_PATH)
        report = _build_report(
            command_center=command_center,
            policy=policy,
            policy_sha=policy_sha,
            snapshot=snapshot,
            heartbeat=heartbeat,
            now=now,
            mode=args.mode,
        )
        markdown = _render_markdown(report)
        if "|" in "\n".join(
            line for line in markdown.splitlines() if line.lstrip().startswith("|")
        ):
            raise ReportError("human report contains a markdown table")
        _persist_report(
            repo=repo,
            token=token,
            report=report,
            markdown=markdown,
            policy=policy,
            mode=args.mode,
        )
    except Exception as exc:
        print(f"DAILY_REPORT_FAILED:{type(exc).__name__}:{str(exc)[:180]}")
        return 4

    print(f"DAILY_REPORT_{args.mode.upper().replace('-', '_')}_PASS:{report['report_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
