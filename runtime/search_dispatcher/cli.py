from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .dispatcher import DispatcherError, SearchDispatcher, canonical_json


def _request_document(path: str | None) -> dict[str, object]:
    text = Path(path).read_text(encoding="utf-8") if path else sys.stdin.read()
    value = json.loads(text)
    if not isinstance(value, dict):
        raise DispatcherError("request root must be an object", code="INVALID_REQUEST")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Search Dispatcher v0.2")
    parser.add_argument("--db", required=True, help="persistent SQLite database path")
    parser.add_argument("--config", help="route/capacity configuration path")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("init")
    submit = subparsers.add_parser("submit")
    submit.add_argument("--file", help="request JSON; stdin when omitted")
    run = subparsers.add_parser("run-once")
    run.add_argument("--worker", required=True)
    run.add_argument("--no-verify", action="store_true")
    subparsers.add_parser("recover")
    verify = subparsers.add_parser("verify")
    verify.add_argument("job_id")
    status = subparsers.add_parser("status")
    status.add_argument("job_or_intent_id")
    readback = subparsers.add_parser("readback")
    readback.add_argument("job_or_intent_id")
    subparsers.add_parser("integrity")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        dispatcher = SearchDispatcher(args.db, config_path=args.config)
        if args.command == "init":
            result = {"state": "INITIALIZED", **dispatcher.integrity()}
        elif args.command == "submit":
            result = dispatcher.submit(_request_document(args.file))
        elif args.command == "run-once":
            result = dispatcher.run_one(args.worker, verify=not args.no_verify)
        elif args.command == "recover":
            result = dispatcher.recover_expired()
        elif args.command == "verify":
            result = dispatcher.verify_one(args.job_id)
        elif args.command == "status":
            result = dispatcher.status(args.job_or_intent_id)
        elif args.command == "readback":
            result = dispatcher.terminal_readback(args.job_or_intent_id)
        elif args.command == "integrity":
            result = dispatcher.integrity()
        else:  # pragma: no cover - argparse owns this boundary
            raise DispatcherError("unknown command", code="UNKNOWN_COMMAND")
        sys.stdout.write(f"{canonical_json(result)}\n")
        return 0
    except (DispatcherError, json.JSONDecodeError, OSError) as error:
        code = getattr(error, "code", "INVALID_INPUT")
        sys.stdout.write(f"{canonical_json({'state': 'FAILED', 'error_code': code})}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
