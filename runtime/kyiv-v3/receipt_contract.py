#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Any

RECEIPT_SCHEMA_VERSION = 1
RESULT_SEMANTICS = frozenset({
    "DELTA_PRESENT",
    "NO_DELTA_OBSERVED",
    "UNKNOWN",
    "NOT_APPLICABLE",
})
PARSER_STATUSES = frozenset({
    "PARSED",
    "PARSED_EMPTY",
    "RAW_FETCHED",
    "IMAGE_PARSED",
    "HTML_PARSED",
    "HTTP_FAILED",
    "EMPTY_RESPONSE",
    "JSON_PARSE_FAILED",
    "IMAGE_PARSE_FAILED",
    "HTML_PARSE_FAILED",
})
FRESHNESS_STATUSES = frozenset({"FRESH", "STALE", "UNKNOWN", "NOT_APPLICABLE"})
SENSITIVE_KEYS = frozenset({"token", "key", "api_key", "apikey", "authorization", "password", "secret"})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

REQUIRED_FIELDS = (
    "receipt_schema_version",
    "receipt_id",
    "run_id",
    "query_id",
    "attempt",
    "collector_id",
    "source_id",
    "measurement_class",
    "source_lineage",
    "independence_group",
    "started_utc",
    "ended_utc",
    "observation_window",
    "endpoint_id",
    "request",
    "http_status",
    "result_status",
    "response_bytes",
    "record_count",
    "elapsed_ms",
    "response_sha256",
    "error",
    "source_latest_utc",
    "freshness",
    "parser",
    "observation_opportunity",
    "result_semantic",
    "result_reason",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def parse_utc(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().replace('.', '', 1).isdigit()):
        try:
            return datetime.fromtimestamp(float(value), timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def canonical_sha256(value: Any) -> str:
    if isinstance(value, bytes):
        data = value
    else:
        data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(data).hexdigest()


def run_id_from_environment(anchor: datetime | None = None) -> str:
    explicit = os.environ.get("KYIV_RUN_ID", "").strip()
    if explicit:
        return explicit
    github_run = os.environ.get("GITHUB_RUN_ID", "").strip()
    github_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1").strip() or "1"
    if github_run:
        return f"KYIV-RUNTIME-{github_run}-A{github_attempt}"
    anchor = anchor or utc_now()
    return f"KYIV-LOCAL-{anchor.strftime('%Y%m%dT%H%M%S%fZ')}-{os.getpid()}"


def clamp_expected_bin_end(source_latest: datetime | None, anchor: datetime, *, max_future_seconds: int = 900) -> tuple[datetime | None, str]:
    if source_latest is None:
        return None, "NO_SOURCE_TIMESTAMP"
    if source_latest <= anchor:
        return source_latest, "DIRECT"
    if (source_latest - anchor).total_seconds() <= max_future_seconds:
        return anchor, "EXPECTED_BIN_END_LABEL_CLAMPED"
    return None, "FUTURE_LABEL_QUARANTINED"


def _source_metadata(host: str, path: str = "") -> tuple[str, str, str]:
    if host == "api.ioda.inetintel.cc.gatech.edu":
        return "IODA", "IODA_PUBLIC_API", "IODA"
    if host == "stat.ripe.net":
        return "RIPE_STAT", "RIPE_RIS", "RIPE_NCC"
    if host == "planetarycomputer.microsoft.com":
        return "PC_STAC", "MICROSOFT_PLANETARY_COMPUTER_STAC", "MICROSOFT_PLANETARY_COMPUTER"
    if host == "t.me":
        channel = next((part for part in path.split("/") if part and part != "s"), "").casefold()
        telegram_sources = {
            "favt_info": ("ROSAVIATSIA_PUBLIC", "TELEGRAM_PUBLIC_WEB_ROSAVIATSIA", "ROSAVIATSIA_TELEGRAM"),
            "generalstaffzsu": ("UA_GENERAL_STAFF_PUBLIC", "TELEGRAM_PUBLIC_WEB_UA_GENERAL_STAFF", "UA_GENERAL_STAFF"),
            "mod_russia": ("RUSSIAN_MOD_PUBLIC", "TELEGRAM_PUBLIC_WEB_RUSSIAN_MOD", "RUSSIAN_MOD"),
            "mchs_official": ("RUSSIAN_EMERGENCY_MINISTRY_PUBLIC", "TELEGRAM_PUBLIC_WEB_RUSSIAN_EMERGENCY_MINISTRY", "RUSSIAN_EMERGENCY_MINISTRY"),
        }
        return telegram_sources.get(channel, ("TELEGRAM_PUBLIC", f"TELEGRAM_PUBLIC_WEB_{channel.upper() or 'UNKNOWN'}", f"TELEGRAM_{channel.upper() or 'UNKNOWN'}"))
    return host.upper().replace(".", "_"), host, host


def _redact(value: Any, *, key: str | None = None) -> Any:
    if key and key.casefold() in SENSITIVE_KEYS:
        return "REDACTED"
    if key == "bbox":
        return "REDACTED_BROAD_ADMIN_TILE_USE_QUERY_ID_AND_CONFIG_HASH"
    if isinstance(value, dict):
        return {str(k): _redact(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def _request_metadata(url: str, payload: Any, method: str) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url)
    params = {k: v if len(v) > 1 else v[0] for k, v in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).items()}
    full_request = {"method": method, "endpoint": f"{parsed.netloc}{parsed.path}", "parameters": params, "body": payload}
    return {
        "method": method,
        "parameters_redacted": _redact(params),
        "body_redacted": _redact(payload),
        "request_sha256": canonical_sha256(full_request),
    }


def _window_from_request(url: str, payload: Any) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url)
    params = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).items()}
    start = params.get("from") or params.get("starttime")
    end = params.get("until") or params.get("endtime")
    interval = payload.get("datetime") if isinstance(payload, dict) else None
    if isinstance(interval, str) and "/" in interval:
        start, end = interval.split("/", 1)
    start_dt, end_dt = parse_utc(start), parse_utc(end)
    if start_dt or end_dt:
        return {"start_utc": utc_iso(start_dt), "end_utc": utc_iso(end_dt), "semantics": "EVENT_OR_ACQUISITION_TIME"}
    return {"start_utc": None, "end_utc": None, "semantics": "NOT_APPLICABLE"}


def build_receipt(
    *,
    run_id: str,
    url: str,
    measurement_class: str,
    query_id: str,
    started: datetime,
    ended: datetime,
    http_status: int,
    raw: bytes,
    elapsed_ms: int,
    error: str | None,
    payload: Any = None,
    attempt: int = 1,
) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url)
    collector_id, source_lineage, independence_group = _source_metadata(parsed.netloc, parsed.path)
    method = "POST" if payload is not None else "GET"
    result_status = "SUCCESS" if http_status == 200 and bool(raw) else "FAILED"
    parser_status = "RAW_FETCHED" if result_status == "SUCCESS" else ("EMPTY_RESPONSE" if http_status == 200 else "HTTP_FAILED")
    identity = canonical_sha256({"run_id": run_id, "query_id": query_id, "attempt": attempt, "started": utc_iso(started)})[:24]
    return {
        "receipt_schema_version": RECEIPT_SCHEMA_VERSION,
        "receipt_id": f"{run_id}:{identity}",
        "run_id": run_id,
        "query_id": query_id,
        "attempt": attempt,
        "collector_id": collector_id,
        "source_id": f"{parsed.netloc}{parsed.path}",
        "measurement_class": measurement_class,
        "source_lineage": source_lineage,
        "independence_group": independence_group,
        "started_utc": utc_iso(started),
        "ended_utc": utc_iso(ended),
        "observation_window": _window_from_request(url, payload),
        "endpoint_id": f"{parsed.netloc}{parsed.path}",
        "request": _request_metadata(url, payload, method),
        "http_status": int(http_status),
        "result_status": result_status,
        "response_bytes": len(raw),
        "record_count": None,
        "elapsed_ms": max(0, int(elapsed_ms)),
        "response_sha256": canonical_sha256(raw) if raw else None,
        "error": error,
        "source_latest_utc": None,
        "freshness": {"status": "UNKNOWN", "age_seconds": None, "max_age_seconds": 21600, "intrinsic_latency_seconds": None},
        "parser": {"status": parser_status, "schema_id": None, "error": error},
        "observation_opportunity": False,
        "result_semantic": "UNKNOWN",
        "result_reason": "TRANSPORT_OR_PARSE_NOT_YET_ADJUDICATED",
        # Compatibility aliases retained for existing artifact readers.
        "class": measurement_class,
        "semantic": query_id,
        "host": parsed.netloc,
        "path": parsed.path,
        "status": int(http_status),
        "bytes": len(raw),
        "sha256": canonical_sha256(raw) if raw else None,
    }


def _record_count(obj: Any) -> int | None:
    if isinstance(obj, list):
        return len(obj)
    if not isinstance(obj, dict):
        return None
    for key in ("features", "updates", "results", "items"):
        if isinstance(obj.get(key), list):
            return len(obj[key])
    data = obj.get("data")
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        for key in ("updates", "results", "items"):
            if isinstance(data.get(key), list):
                return len(data[key])
        return 1
    return 1


def _latest_timestamp(obj: Any) -> datetime | None:
    latest: datetime | None = None
    timestamp_keys = {"timestamp", "datetime", "start_datetime", "end_datetime", "until", "latest_utc", "latest_event_utc"}

    def walk(value: Any, key: str | None = None) -> None:
        nonlocal latest
        if key in timestamp_keys:
            candidate = parse_utc(value)
            if candidate and datetime(2022, 1, 1, tzinfo=timezone.utc) <= candidate <= datetime(2035, 1, 1, tzinfo=timezone.utc):
                latest = candidate if latest is None or candidate > latest else latest
        if isinstance(value, dict):
            for child_key, child in value.items():
                walk(child, str(child_key))
        elif isinstance(value, list):
            for child in value:
                walk(child, key)

    walk(obj)
    return latest


def _set_freshness(receipt: dict[str, Any], source_latest: datetime | None, *, max_age_seconds: int = 21600) -> None:
    receipt["source_latest_utc"] = utc_iso(source_latest)
    ended = parse_utc(receipt.get("ended_utc"))
    if source_latest is None or ended is None:
        receipt["freshness"] = {"status": "UNKNOWN", "age_seconds": None, "max_age_seconds": max_age_seconds, "intrinsic_latency_seconds": None}
        return
    age = (ended - source_latest).total_seconds()
    if age < 0:
        receipt["freshness"] = {"status": "UNKNOWN", "age_seconds": None, "max_age_seconds": max_age_seconds, "intrinsic_latency_seconds": None}
        return
    receipt["freshness"] = {
        "status": "FRESH" if age <= max_age_seconds else "STALE",
        "age_seconds": round(age, 3),
        "max_age_seconds": max_age_seconds,
        "intrinsic_latency_seconds": None,
    }


def finalize_json_receipt(receipt: dict[str, Any], obj: Any, *, schema_id: str = "JSON") -> None:
    count = _record_count(obj)
    receipt["record_count"] = count
    receipt["parser"] = {"status": "PARSED_EMPTY" if count == 0 else "PARSED", "schema_id": schema_id, "error": None}
    _set_freshness(receipt, _latest_timestamp(obj))


def finalize_parse_failure(receipt: dict[str, Any], status: str, error: str) -> None:
    receipt["parser"] = {"status": status, "schema_id": None, "error": error}
    receipt["observation_opportunity"] = False
    receipt["result_semantic"] = "UNKNOWN"
    receipt["result_reason"] = status


def finalize_non_json_receipt(
    receipt: dict[str, Any],
    *,
    parser_status: str,
    record_count: int | None,
    source_latest: datetime | None,
    schema_id: str,
) -> None:
    receipt["record_count"] = record_count
    receipt["parser"] = {"status": parser_status, "schema_id": schema_id, "error": None}
    _set_freshness(receipt, source_latest)


def set_receipt_result(
    receipt: dict[str, Any],
    semantic: str,
    reason: str,
    *,
    observation_opportunity: bool,
    source_latest: datetime | None = None,
    record_count: int | None = None,
) -> None:
    if semantic not in RESULT_SEMANTICS:
        raise ValueError(f"invalid result semantic: {semantic}")
    if source_latest is not None:
        _set_freshness(receipt, source_latest)
    if record_count is not None:
        receipt["record_count"] = record_count
    receipt["observation_opportunity"] = bool(observation_opportunity)
    receipt["result_semantic"] = semantic
    receipt["result_reason"] = reason


def validate_receipts(rows: list[dict[str, Any]], expected_run_id: str | None) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    receipt_ids: set[str] = set()
    row_run_ids: set[str] = set()

    def fail(line: int, field: str, reason: str) -> None:
        errors.append({"line": line, "field": field, "reason": reason})

    for line, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            fail(line, "$", "ROW_NOT_OBJECT")
            continue
        for field in REQUIRED_FIELDS:
            if field not in row:
                fail(line, field, "MISSING")
        if any(field not in row for field in REQUIRED_FIELDS):
            continue
        if row["receipt_schema_version"] != RECEIPT_SCHEMA_VERSION:
            fail(line, "receipt_schema_version", "UNSUPPORTED")
        run_id = row.get("run_id")
        if not isinstance(run_id, str) or not run_id.strip():
            fail(line, "run_id", "EMPTY_OR_INVALID")
        else:
            row_run_ids.add(run_id)
            if expected_run_id and run_id != expected_run_id:
                fail(line, "run_id", "MISMATCH_TOP_LEVEL")
        receipt_id = row.get("receipt_id")
        if not isinstance(receipt_id, str) or not receipt_id:
            fail(line, "receipt_id", "EMPTY_OR_INVALID")
        elif receipt_id in receipt_ids:
            fail(line, "receipt_id", "DUPLICATE")
        else:
            receipt_ids.add(receipt_id)
        for field in ("query_id", "collector_id", "source_id", "measurement_class", "source_lineage", "independence_group", "endpoint_id", "result_reason"):
            if not isinstance(row.get(field), str) or not row[field].strip():
                fail(line, field, "EMPTY_OR_INVALID")
        if not isinstance(row.get("attempt"), int) or row["attempt"] < 1:
            fail(line, "attempt", "INVALID")
        started, ended = parse_utc(row.get("started_utc")), parse_utc(row.get("ended_utc"))
        if not started:
            fail(line, "started_utc", "INVALID")
        if not ended:
            fail(line, "ended_utc", "INVALID")
        if started and ended and started > ended:
            fail(line, "ended_utc", "BEFORE_START")
        if not isinstance(row.get("observation_window"), dict) or row["observation_window"].get("semantics") not in {"EVENT_OR_ACQUISITION_TIME", "NOT_APPLICABLE"}:
            fail(line, "observation_window", "INVALID")
        else:
            window_start=parse_utc(row["observation_window"].get("start_utc"));window_end=parse_utc(row["observation_window"].get("end_utc"))
            if window_start and window_end and window_start>window_end:
                fail(line,"observation_window","END_BEFORE_START")
        request = row.get("request")
        if not isinstance(request, dict) or request.get("method") not in {"GET", "POST"} or "parameters_redacted" not in request or "body_redacted" not in request or not SHA256_RE.fullmatch(str(request.get("request_sha256", ""))):
            fail(line, "request", "INVALID")
        if not isinstance(row.get("http_status"), int) or not 0 <= row["http_status"] <= 599:
            fail(line, "http_status", "INVALID")
        if row.get("result_status") not in {"SUCCESS","FAILED"}:
            fail(line,"result_status","INVALID")
        if not isinstance(row.get("response_bytes"), int) or row["response_bytes"] < 0:
            fail(line, "response_bytes", "INVALID")
        if row.get("record_count") is not None and (not isinstance(row["record_count"], int) or row["record_count"] < 0):
            fail(line, "record_count", "INVALID")
        if not isinstance(row.get("elapsed_ms"), int) or row["elapsed_ms"] < 0:
            fail(line, "elapsed_ms", "INVALID")
        response_hash = row.get("response_sha256")
        if row["response_bytes"] > 0 and not SHA256_RE.fullmatch(str(response_hash or "")):
            fail(line, "response_sha256", "MISSING_OR_INVALID_FOR_NONEMPTY_RESPONSE")
        if response_hash is not None and not SHA256_RE.fullmatch(str(response_hash)):
            fail(line, "response_sha256", "INVALID")
        if row.get("source_latest_utc") is not None:
            source_latest=parse_utc(row["source_latest_utc"])
            if not source_latest:
                fail(line, "source_latest_utc", "INVALID")
            elif ended and source_latest>ended:
                fail(line,"source_latest_utc","FUTURE_VS_QUERY_END")
        freshness = row.get("freshness")
        if not isinstance(freshness, dict) or freshness.get("status") not in FRESHNESS_STATUSES:
            fail(line, "freshness", "INVALID")
        parser = row.get("parser")
        if not isinstance(parser, dict) or parser.get("status") not in PARSER_STATUSES:
            fail(line, "parser", "INVALID")
        if not isinstance(row.get("observation_opportunity"), bool):
            fail(line, "observation_opportunity", "INVALID")
        semantic = row.get("result_semantic")
        if semantic not in RESULT_SEMANTICS:
            fail(line, "result_semantic", "INVALID")
        if semantic in {"DELTA_PRESENT", "NO_DELTA_OBSERVED"}:
            parser_ok = isinstance(parser, dict) and parser.get("status") in {"PARSED", "PARSED_EMPTY", "IMAGE_PARSED", "HTML_PARSED"}
            if row.get("http_status") != 200 or not parser_ok or row.get("observation_opportunity") is not True:
                fail(line, "result_semantic", "ASSERTED_WITHOUT_OBSERVATION_OPPORTUNITY")
            if not isinstance(freshness,dict) or freshness.get("status")!='FRESH':
                fail(line,"result_semantic","ASSERTED_WITHOUT_FRESHNESS")

    run_linkage_passed = bool(expected_run_id) and len(row_run_ids) == 1 and row_run_ids == {expected_run_id}
    if not expected_run_id:
        errors.append({"line": 0, "field": "run_id", "reason": "TOP_LEVEL_MISSING"})
    elif not run_linkage_passed:
        errors.append({"line": 0, "field": "run_id", "reason": "MIXED_OR_MISSING_LINKAGE"})
    schema_passed = not errors
    return {
        "receipt_schema_version": RECEIPT_SCHEMA_VERSION,
        "rows": len(rows),
        "schema_passed": schema_passed,
        "run_linkage_passed": run_linkage_passed,
        "semantic_enum_passed": not any(error["field"] == "result_semantic" for error in errors),
        "unique_receipt_ids_passed": len(receipt_ids) == len(rows),
        "errors": errors[:25],
        "error_count": len(errors),
    }
