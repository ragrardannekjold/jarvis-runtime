#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import os
import time
from typing import Any, Callable

import generate_daily_main_report as generator

ReadFunction = Callable[..., tuple[str | None, str | None]]
RequestFunction = Callable[..., tuple[int, Any]]
SleepFunction = Callable[[float], None]


def resilient_write_private_text_with_readback(
    repo: str,
    token: str,
    path: str,
    content: str,
    *,
    message: str,
    attempts: int = 7,
    base_delay_seconds: float = 0.5,
    read_function: ReadFunction | None = None,
    request_function: RequestFunction | None = None,
    sleep_function: SleepFunction | None = None,
) -> str:
    if attempts < 1:
        raise ValueError("readback attempts must be at least 1")
    if base_delay_seconds < 0:
        raise ValueError("readback base delay must not be negative")

    read = read_function or generator._read_private_text
    request = request_function or generator._request
    sleep = sleep_function or time.sleep

    _current, current_sha = read(repo, token, path, missing_ok=True)
    body: dict[str, Any] = {
        "message": message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": generator.STATE_BRANCH,
    }
    if current_sha:
        body["sha"] = current_sha

    status, _payload = request(
        generator._content_url(repo, path),
        token,
        method="PUT",
        payload=body,
    )
    if status not in {200, 201}:
        raise generator.ReportError(f"private write failed for {path}: HTTP {status}")

    expected_sha256 = hashlib.sha256(content.encode("utf-8")).hexdigest()
    last_observation = "no readback attempted"

    for index in range(attempts):
        try:
            readback, _readback_sha = read(repo, token, path)
        except generator.ReportError as exc:
            last_observation = str(exc)
        else:
            if readback == content:
                return expected_sha256
            observed_sha256 = (
                hashlib.sha256((readback or "").encode("utf-8")).hexdigest()
            )
            last_observation = (
                "stale or mismatched content: "
                f"expected_sha256={expected_sha256} observed_sha256={observed_sha256}"
            )

        if index + 1 < attempts:
            sleep(base_delay_seconds * (2**index))

    raise generator.ReportError(
        f"private readback did not converge for {path} after {attempts} attempts: "
        f"{last_observation}"
    )


def install_resilient_writer() -> None:
    attempts = int(os.environ.get("DAILY_REPORT_READBACK_ATTEMPTS", "7"))
    base_delay = float(os.environ.get("DAILY_REPORT_READBACK_BASE_DELAY_SECONDS", "0.5"))

    def writer(
        repo: str,
        token: str,
        path: str,
        content: str,
        *,
        message: str,
    ) -> str:
        return resilient_write_private_text_with_readback(
            repo,
            token,
            path,
            content,
            message=message,
            attempts=attempts,
            base_delay_seconds=base_delay,
        )

    generator._write_private_text_with_readback = writer


def main() -> int:
    install_resilient_writer()
    return generator.main()


if __name__ == "__main__":
    raise SystemExit(main())
