#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

DANGEROUS_FRAGMENTS = (
    "ragrardannekjold/ragrardannekjold-liski-scene-agent-1",
    "git push origin HEAD:main",
)


def _load_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} root must be an object")
    return payload


def validate_inventory(*, public_root: Path, command_center: Path) -> dict[str, Any]:
    registry = _load_object(command_center / "config/module_registry.json")
    modules_raw = registry.get("modules")
    bindings_raw = registry.get("public_workflow_bindings")
    forbidden_raw = registry.get("forbidden_public_paths")
    if not isinstance(modules_raw, list) or not isinstance(bindings_raw, dict):
        raise ValueError("private module registry lacks public workflow inventory")
    if not isinstance(forbidden_raw, list):
        raise ValueError("private module registry lacks forbidden_public_paths")

    modules: dict[str, dict[str, Any]] = {}
    for item in modules_raw:
        if not isinstance(item, dict) or not isinstance(item.get("module_id"), str):
            raise ValueError("invalid module entry in private registry")
        modules[item["module_id"]] = item

    workflows_dir = public_root / ".github/workflows"
    actual = sorted(path.name for path in workflows_dir.glob("*.yml") if path.is_file())
    expected = sorted(str(name) for name in bindings_raw)
    missing = sorted(set(expected) - set(actual))
    unbound = sorted(set(actual) - set(expected))
    if missing or unbound:
        raise ValueError(
            f"public workflow inventory mismatch: missing={missing}, unbound={unbound}"
        )

    for relative in forbidden_raw:
        if not isinstance(relative, str) or not relative.strip():
            raise ValueError("forbidden public path must be a non-empty string")
        if (public_root / relative).exists():
            raise ValueError(f"forbidden retired public path is present: {relative}")

    workflow_results: list[dict[str, Any]] = []
    for workflow_name in actual:
        module_id = bindings_raw.get(workflow_name)
        if not isinstance(module_id, str) or module_id not in modules:
            raise ValueError(f"workflow binding references unknown module: {workflow_name}")
        module = modules[module_id]
        state = module.get("state")
        text = (workflows_dir / workflow_name).read_text(encoding="utf-8")
        lowered = text.lower()
        for fragment in DANGEROUS_FRAGMENTS:
            if fragment.lower() in lowered:
                raise ValueError(
                    f"dangerous public workflow fragment in {workflow_name}: {fragment}"
                )
        if "secrets.command_center_token" in lowered and "pull_request:" in lowered:
            raise ValueError(
                f"secret-bearing workflow cannot run on pull_request: {workflow_name}"
            )
        if state in {"DISABLED", "QUARANTINED", "RETIRED"}:
            raise ValueError(
                f"public workflow {workflow_name} is bound to non-runnable module {module_id}:{state}"
            )
        if state == "SHADOW":
            if not workflow_name.endswith("self-test.yml"):
                raise ValueError(
                    f"SHADOW module may expose only self-test workflow: {workflow_name}"
                )
            if "schedule:" in text:
                raise ValueError(
                    f"SHADOW self-test cannot have a schedule: {workflow_name}"
                )
        workflow_results.append(
            {"workflow": workflow_name, "module_id": module_id, "module_state": state}
        )

    manifest = _load_object(public_root / "PUBLIC_EXPORT_MANIFEST.json")
    allowlist_raw = manifest.get("allowlist")
    if not isinstance(allowlist_raw, list):
        raise ValueError("public export manifest requires allowlist")
    allowlist = {str(item) for item in allowlist_raw}
    operational_files = {
        str(path.relative_to(public_root))
        for pattern in (".github/workflows/*.yml", "runtime/*.py", "runtime/*.txt")
        for path in public_root.glob(pattern)
        if path.is_file()
    }
    omitted = sorted(operational_files - allowlist)
    stale_manifest = sorted(
        path
        for path in allowlist
        if path.startswith((".github/workflows/", "runtime/"))
        and not (public_root / path).is_file()
    )
    if omitted or stale_manifest:
        raise ValueError(
            f"public export manifest mismatch: omitted={omitted}, stale={stale_manifest}"
        )

    return {
        "status": "PASS",
        "workflow_count": len(actual),
        "workflows": workflow_results,
        "forbidden_paths_absent": len(forbidden_raw),
        "manifest_operational_files_verified": len(operational_files),
        "direct_private_main_push_absent": True,
        "legacy_repository_checkout_absent": True,
        "secret_pull_request_trigger_absent": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-root", default=".")
    parser.add_argument("--command-center", default="command-center")
    args = parser.parse_args()
    try:
        result = validate_inventory(
            public_root=Path(args.public_root).resolve(),
            command_center=Path(args.command_center).resolve(),
        )
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"PUBLIC_RUNTIME_INVENTORY_FAILED:{exc}")
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
