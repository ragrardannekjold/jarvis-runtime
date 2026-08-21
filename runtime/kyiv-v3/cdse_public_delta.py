#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

import cdse_event_queue as q

UA = "KyivCDSEPublicDelta/1.0 (+defensive-civilian-safety)"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def github_latest_v3_created(github_token: str, repository: str) -> datetime | None:
    url = (
        f"https://api.github.com/repos/{repository}/actions/workflows/{q.WORKFLOW}/runs"
        "?branch=main&status=success&per_page=1"
    )
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {github_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"GITHUB_RUN_LOOKUP_FAILED_{exc.code}") from exc
    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list) or not runs:
        return None
    created = runs[0].get("created_at") if isinstance(runs[0], dict) else None
    if not isinstance(created, str):
        return None
    try:
        return datetime.fromisoformat(created.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def odata_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def public_products_since(since: datetime) -> list[dict[str, Any]]:
    filt = f"{q.FILTER} and PublicationDate gt {odata_time(since)}"
    params = urllib.parse.urlencode(
        {
            "$filter": filt,
            "$select": "Id,Name,PublicationDate",
            "$orderby": "PublicationDate desc",
            "$top": "20",
        }
    )
    status, payload = q.http_json(f"{q.CATALOGUE}/Products?{params}", timeout=30)
    if status != 200:
        raise RuntimeError(f"CDSE_PUBLIC_DELTA_FAILED_{status}")
    return q.as_list(payload)


def normalized_public_items(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in products:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "ProductId": item.get("Id"),
                "ProductName": item.get("Name"),
                "NotificationDate": item.get("PublicationDate"),
            }
        )
    return out


def run() -> q.RunResult:
    github_token = os.environ.get("GITHUB_TOKEN", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if not github_token or not repository:
        return q.RunResult("DISABLED_MISSING_GITHUB_CONTEXT")

    latest = github_latest_v3_created(github_token, repository)
    # Bound first-run discovery so deployment never causes a historical flood.
    since = latest if latest is not None else now_utc() - timedelta(minutes=15)
    products = public_products_since(since)
    if not products:
        return q.RunResult("NO_NEW_PUBLICATIONS")

    items = normalized_public_items(products)
    summary = q.sanitized_summary(items)
    q.dispatch_refresh(github_token, repository)
    return q.RunResult(
        "PUBLICATION_DELTA_REFRESH_DISPATCHED",
        event_count=len(items),
        dispatched=True,
        acknowledged=False,
        detail={**summary, "mode": "PUBLICATION_DATE_FALLBACK"},
    )


def main() -> int:
    try:
        result = run()
        result.emit()
        return 0
    except Exception as exc:
        print(json.dumps({"state": "ERROR", "error": type(exc).__name__, "detail": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
