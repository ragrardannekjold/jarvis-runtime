#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_BRANCH = "jarvis-runtime-state"
CACHE_PATH = "runtime/ai39/cdse-stac/latest.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def request_json(
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
            "User-Agent": "jarvis-ai39-cdse-cache/1.0",
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


def validate_cache(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("cache_payload_not_object")
    if payload.get("route_id") != "cdse-stac-public":
        raise ValueError("cache_route_mismatch")
    if payload.get("state") != "LIVE_READBACK":
        raise ValueError("cache_requires_live_readback")
    if payload.get("truth_rule") != "METADATA_ONLY != PIXELS_VIEWED":
        raise ValueError("cache_truth_rule_missing")
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("cache_requires_candidates")
    if payload.get("candidate_count") != len(candidates):
        raise ValueError("cache_candidate_count_mismatch")
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ValueError("cache_candidate_not_object")
        if candidate.get("collection") != "sentinel-1-grd":
            raise ValueError("cache_collection_mismatch")
        if candidate.get("pixel_state") != "METADATA_ONLY_PIXELS_NOT_VIEWED":
            raise ValueError("cache_pixel_truth_violation")
        if candidate.get("provenance_state") != "PUBLIC_STAC_DISCOVERY":
            raise ValueError("cache_provenance_missing")

    out = dict(payload)
    out["private_only"] = True
    out["cache_path"] = CACHE_PATH
    out["cache_branch"] = STATE_BRANCH
    out["cache_persisted_utc"] = utc_now()
    out["source_workflow_run_id"] = os.environ.get("GITHUB_RUN_ID")
    out["source_workflow_attempt"] = os.environ.get("GITHUB_RUN_ATTEMPT")
    return out


def persist(*, repo: str, token: str, payload: dict[str, Any]) -> None:
    encoded_path = urllib.parse.quote(CACHE_PATH, safe="/")
    branch_q = urllib.parse.quote(STATE_BRANCH)
    read_url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}?ref={branch_q}"
    status, current = request_json(read_url, token)
    sha = current.get("sha") if status == 200 and isinstance(current, dict) else None
    if status not in {200, 404}:
        raise RuntimeError(f"cache_readback_http_{status}")

    encoded = base64.b64encode(
        (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    ).decode("ascii")
    body: dict[str, Any] = {
        "message": f"AI39 CDSE STAC cache {payload['cache_persisted_utc']}",
        "content": encoded,
        "branch": STATE_BRANCH,
    }
    if isinstance(sha, str) and sha:
        body["sha"] = sha

    write_url = f"https://api.github.com/repos/{repo}/contents/{encoded_path}"
    write_status, _ = request_json(write_url, token, method="PUT", payload=body)
    if write_status not in {200, 201}:
        raise RuntimeError(f"cache_persist_http_{write_status}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Persist private AI39 CDSE STAC discovery cache")
    parser.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()

    repo = os.environ.get("AI39_STATE_REPO", "").strip()
    token = os.environ.get("AI39_STATE_WRITE_TOKEN", "").strip()
    if not repo or not token:
        print("AI39_CDSE_STAC_CACHE_BRIDGE_NOT_CONFIGURED")
        return 2
    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        cache = validate_cache(payload)
        persist(repo=repo, token=token, payload=cache)
    except Exception as exc:
        print(f"AI39_CDSE_STAC_CACHE_FAILED:{type(exc).__name__}")
        return 4

    print("AI39_CDSE_STAC_CACHE_PERSISTED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
