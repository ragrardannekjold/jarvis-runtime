#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
CATALOGUE = "https://catalogue.dataspace.copernicus.eu/odata/v1"
WORKFLOW = "kyiv-v3-public-collector.yml"
UA = "KyivCDSEEventQueue/1.0 (+defensive-civilian-safety)"

# Broad oblast-scale envelope only. Do not narrow this runtime to target-level military AOIs.
AREA = "POLYGON((31.20 49.45,42.95 49.45,42.95 54.05,31.20 54.05,31.20 49.45))"
S1 = (
    "Collection/Name eq 'SENTINEL-1' and "
    "Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType' and "
    "att/OData.CSC.StringAttribute/Value eq 'IW_GRDH_1S')"
)
S2 = (
    "Collection/Name eq 'SENTINEL-2' and "
    "Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType' and "
    "att/OData.CSC.StringAttribute/Value eq 'S2MSI2A')"
)
FILTER = f"(({S1}) or ({S2})) and OData.CSC.Intersects(area=geography'SRID=4326;{AREA}')"


def stable_hash(value: str, size: int = 16) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:size]


def http_json(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    data: dict[str, Any] | None = None,
    form: dict[str, str] | None = None,
    timeout: int = 30,
) -> tuple[int, Any]:
    headers = {"User-Agent": UA, "Accept": "application/json"}
    body: bytes | None = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data, separators=(",", ":")).encode("utf-8")
    elif form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        body = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return resp.status, None
            return resp.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        detail: Any = None
        if raw:
            try:
                detail = json.loads(raw.decode("utf-8"))
            except Exception:
                detail = {"error": f"HTTP_{exc.code}"}
        return exc.code, detail


def cdse_token(username: str, password: str) -> str:
    status, payload = http_json(
        TOKEN_URL,
        method="POST",
        form={
            "grant_type": "password",
            "username": username,
            "password": password,
            "client_id": "cdse-public",
        },
    )
    if status != 200 or not isinstance(payload, dict) or not payload.get("access_token"):
        raise RuntimeError(f"CDSE_AUTH_FAILED_{status}")
    return str(payload["access_token"])


def as_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        value = payload.get("value")
        if isinstance(value, list):
            return [x for x in value if isinstance(x, dict)]
    return []


def subscription_matches(item: dict[str, Any]) -> bool:
    return (
        str(item.get("SubscriptionType", "")).lower() == "pull"
        and str(item.get("FilterParam", "")) == FILTER
        and "created" in [str(x).lower() for x in item.get("SubscriptionEvent", []) if isinstance(x, str)]
        and str(item.get("Status", "")).lower() in {"running", "paused"}
    )


def ensure_subscription(token: str) -> str:
    status, payload = http_json(f"{CATALOGUE}/Subscriptions/Info", token=token)
    if status != 200:
        raise RuntimeError(f"CDSE_SUBSCRIPTION_INFO_FAILED_{status}")
    for item in as_list(payload):
        if not subscription_matches(item):
            continue
        sid = str(item.get("Id", ""))
        if not sid:
            continue
        if str(item.get("Status", "")).lower() == "paused":
            pstatus, _ = http_json(
                f"{CATALOGUE}/Subscriptions({sid})",
                method="PATCH",
                token=token,
                data={"Status": "running"},
            )
            if pstatus != 200:
                raise RuntimeError(f"CDSE_SUBSCRIPTION_RESUME_FAILED_{pstatus}")
        return sid

    status, created = http_json(
        f"{CATALOGUE}/Subscriptions",
        method="POST",
        token=token,
        data={
            "FilterParam": FILTER,
            "StageOrder": False,
            "Status": "running",
            "SubscriptionEvent": ["created"],
            "SubscriptionType": "pull",
        },
    )
    if status != 201 or not isinstance(created, dict) or not created.get("Id"):
        raise RuntimeError(f"CDSE_SUBSCRIPTION_CREATE_FAILED_{status}")
    return str(created["Id"])


def read_notifications(token: str, subscription_id: str, limit: int = 100) -> list[dict[str, Any]]:
    url = f"{CATALOGUE}/Subscriptions({subscription_id})/Read?%24top={int(limit)}"
    status, payload = http_json(url, token=token)
    if status != 200:
        raise RuntimeError(f"CDSE_SUBSCRIPTION_READ_FAILED_{status}")
    return as_list(payload)


def ack_notifications(token: str, subscription_id: str, ack_id: str) -> None:
    q = urllib.parse.urlencode({"$ackid": ack_id})
    status, _ = http_json(
        f"{CATALOGUE}/Subscriptions({subscription_id})/Ack?{q}",
        method="POST",
        token=token,
    )
    if status != 200:
        raise RuntimeError(f"CDSE_SUBSCRIPTION_ACK_FAILED_{status}")


def notification_family(item: dict[str, Any]) -> str:
    value = item.get("value") if isinstance(item.get("value"), dict) else {}
    attrs = value.get("Attributes") if isinstance(value.get("Attributes"), list) else []
    for attr in attrs:
        if not isinstance(attr, dict):
            continue
        if str(attr.get("Name", "")) == "platformShortName":
            platform = str(attr.get("Value", "")).upper()
            if platform.startswith("SENTINEL-1"):
                return "S1"
            if platform.startswith("SENTINEL-2"):
                return "S2"
    name = str(item.get("ProductName", "")).upper()
    if name.startswith("S1"):
        return "S1"
    if name.startswith("S2"):
        return "S2"
    return "OTHER"


def sanitized_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    families = {"S1": 0, "S2": 0, "OTHER": 0}
    dates: list[str] = []
    ids: list[str] = []
    for item in items:
        families[notification_family(item)] += 1
        if isinstance(item.get("NotificationDate"), str):
            dates.append(str(item["NotificationDate"]))
        if isinstance(item.get("ProductId"), str):
            ids.append(str(item["ProductId"]))
    digest = stable_hash("|".join(sorted(ids))) if ids else None
    return {
        "event_count": len(items),
        "families": families,
        "latest_notification_utc": max(dates) if dates else None,
        "batch_digest": digest,
    }


def dispatch_refresh(github_token: str, repository: str, ref: str = "main") -> None:
    if not repository or "/" not in repository:
        raise RuntimeError("GITHUB_REPOSITORY_INVALID")
    url = f"https://api.github.com/repos/{repository}/actions/workflows/{WORKFLOW}/dispatches"
    headers = {
        "User-Agent": UA,
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {github_token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(
        url,
        method="POST",
        headers=headers,
        data=json.dumps({"ref": ref}).encode("utf-8"),
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status != 204:
                raise RuntimeError(f"GITHUB_DISPATCH_FAILED_{resp.status}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"GITHUB_DISPATCH_FAILED_{exc.code}") from exc


@dataclass(frozen=True)
class RunResult:
    state: str
    event_count: int = 0
    dispatched: bool = False
    acknowledged: bool = False
    detail: dict[str, Any] | None = None

    def emit(self) -> None:
        payload = {
            "state": self.state,
            "event_count": self.event_count,
            "dispatched": self.dispatched,
            "acknowledged": self.acknowledged,
        }
        if self.detail:
            payload.update(self.detail)
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def run() -> RunResult:
    username = os.environ.get("CDSE_USERNAME", "").strip()
    password = os.environ.get("CDSE_PASSWORD", "")
    if not username or not password:
        return RunResult("DISABLED_MISSING_CDSE_CREDENTIALS")

    token = cdse_token(username, password)
    sid = ensure_subscription(token)
    items = read_notifications(token, sid)
    if not items:
        return RunResult("NO_NEW_SCENES")

    summary = sanitized_summary(items)
    last_ack = next(
        (str(x.get("AckId")) for x in reversed(items) if isinstance(x.get("AckId"), str) and x.get("AckId")),
        "",
    )
    if not last_ack:
        raise RuntimeError("CDSE_NOTIFICATION_MISSING_ACK_ID")

    gh_token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not gh_token:
        raise RuntimeError("GITHUB_TOKEN_MISSING")

    # Delivery semantics: trigger refresh first; only then acknowledge the CDSE queue.
    # If dispatch fails, the event remains in CDSE and is retried on the next run.
    dispatch_refresh(gh_token, repo)
    ack_notifications(token, sid, last_ack)
    return RunResult(
        "SCENE_EVENT_REFRESH_DISPATCHED",
        event_count=len(items),
        dispatched=True,
        acknowledged=True,
        detail=summary,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--print-filter-hash", action="store_true")
    args = parser.parse_args()
    if args.print_filter_hash:
        print(stable_hash(FILTER))
        return 0
    try:
        result = run()
        result.emit()
        return 0
    except Exception as exc:
        print(json.dumps({"state": "ERROR", "error": type(exc).__name__, "detail": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
