from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class CenemyOperatingBundle:
    """Sanitized contract fixture for the exact AI-49 wrapper tests."""

    project: str


def load_operating_bundle(path: str | Path) -> CenemyOperatingBundle:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("synthetic operating bundle must be an object")
    project = raw.get("project")
    if not isinstance(project, str) or not project.strip():
        raise ValueError("synthetic operating bundle requires project")
    return CenemyOperatingBundle(project=project.strip())
