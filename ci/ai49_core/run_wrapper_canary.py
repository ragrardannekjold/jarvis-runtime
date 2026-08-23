#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile

from jarvis.cenemy_pr_smm import load_operating_bundle
from jarvis.chat_session_recovery import load_chat_session_recovery_policy
from jarvis.truth_guarded_orchestration import run_truth_guard_canary_suite


ROOT = Path(__file__).resolve().parent
OBJECTIVE = (
    "Продовжуй активне PR/SMM глибоке дослідження, перевір competing "
    "hypotheses і поверни перевірений компактний результат."
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=10)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.repeat < 1:
        raise SystemExit("repeat must be >= 1")

    bundle = load_operating_bundle(
        ROOT / "config" / "cenemy_pr_smm_operating_bundle_v1.json"
    )
    policy = load_chat_session_recovery_policy(
        ROOT / "config" / "chat_session_recovery_policy.json"
    )
    with tempfile.TemporaryDirectory() as tmp:
        result = run_truth_guard_canary_suite(
            root=tmp,
            bundle=bundle,
            recovery_policy=policy,
            objective=OBJECTIVE,
            source_refs=["AI-49", "SANITIZED_CONTRACT_FIXTURE"],
            repeat=args.repeat,
        )

    payload = result.to_dict()
    payload.update(
        {
            "schema_version": "AI49_PUBLIC_WRAPPER_CANARY_V1",
            "truth_boundary": (
                "Exact private truth_guard.py, exact private "
                "truth_guarded_orchestration.py and exact private tests; "
                "dependencies are sanitized contract fixtures, not the private "
                "production orchestration implementation."
            ),
            "new_spend": 0,
        }
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
