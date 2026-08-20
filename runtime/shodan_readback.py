"""Secret-safe Shodan credential readback for the public runtime.

This module intentionally calls only Shodan's account information endpoint. It
does not perform host search, scanning, DNS lookup, or any other credit-bearing
operation. Public output is reduced to capability booleans; the credential,
request URL, account plan, and exact credit balances are never printed.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping


API_INFO_ENDPOINT = "https://api.shodan.io/api-info"
MAX_RESPONSE_BYTES = 64 * 1024
DEFAULT_TIMEOUT_SECONDS = 12


class ShodanReadbackError(RuntimeError):
    """Finite, credential-safe failure raised by the readback boundary."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ShodanAccountInfo:
    plan: str
    query_credits: int
    scan_credits: int
    monitored_ips: int


def _required_nonnegative_int(payload: Mapping[str, Any], field: str) -> int:
    value = payload.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ShodanReadbackError("SHODAN_RESPONSE_INVALID")
    return value


def _validate_key(api_key: str) -> str:
    if not isinstance(api_key, str):
        raise ShodanReadbackError("SHODAN_CREDENTIAL_MISSING")
    key = api_key.strip()
    if not key:
        raise ShodanReadbackError("SHODAN_CREDENTIAL_MISSING")
    if not 8 <= len(key) <= 256 or any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise ShodanReadbackError("SHODAN_CREDENTIAL_INVALID_FORMAT")
    return key


def verify_shodan_api_key(
    api_key: str,
    *,
    open_url: Callable[..., Any] = urllib.request.urlopen,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> ShodanAccountInfo:
    """Verify a Shodan key through `/api-info` without spending query credits."""

    key = _validate_key(api_key)
    request_url = f"{API_INFO_ENDPOINT}?{urllib.parse.urlencode({'key': key})}"
    request = urllib.request.Request(
        request_url,
        headers={"Accept": "application/json", "User-Agent": "jarvis-runtime-shodan-readback/1"},
        method="GET",
    )

    try:
        with open_url(request, timeout=timeout_seconds) as response:
            status = getattr(response, "status", 200)
            if status != 200:
                raise ShodanReadbackError("SHODAN_HTTP_ERROR")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise ShodanReadbackError("SHODAN_AUTH_REJECTED") from None
        if error.code == 429:
            raise ShodanReadbackError("SHODAN_RATE_LIMITED") from None
        raise ShodanReadbackError("SHODAN_HTTP_ERROR") from None
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError):
        raise ShodanReadbackError("SHODAN_NETWORK_ERROR") from None

    if len(raw) > MAX_RESPONSE_BYTES:
        raise ShodanReadbackError("SHODAN_RESPONSE_TOO_LARGE")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ShodanReadbackError("SHODAN_RESPONSE_INVALID") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("plan"), str) or not payload["plan"].strip():
        raise ShodanReadbackError("SHODAN_RESPONSE_INVALID")

    return ShodanAccountInfo(
        plan=payload["plan"].strip(),
        query_credits=_required_nonnegative_int(payload, "query_credits"),
        scan_credits=_required_nonnegative_int(payload, "scan_credits"),
        monitored_ips=_required_nonnegative_int(payload, "monitored_ips"),
    )


def build_public_receipt(info: ShodanAccountInfo) -> dict[str, Any]:
    """Return only non-identifying, non-balance capability state."""

    return {
        "provider": "shodan",
        "credential_status": "VERIFIED",
        "endpoint": "/api-info",
        "search_executed": False,
        "query_credits_spent": 0,
        "query_capability_available": info.query_credits > 0,
        "scan_capability_available": info.scan_credits > 0,
        "monitoring_configured": info.monitored_ips > 0,
    }


def run_cli(env: Mapping[str, str] | None = None, *, open_url: Callable[..., Any] = urllib.request.urlopen) -> int:
    runtime_env = os.environ if env is None else env
    try:
        info = verify_shodan_api_key(runtime_env.get("SHODAN_API_KEY", ""), open_url=open_url)
    except ShodanReadbackError as error:
        print(json.dumps({"provider": "shodan", "credential_status": "FAILED", "reason": error.code}, separators=(",", ":")))
        return 1
    print(json.dumps(build_public_receipt(info), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(run_cli())
