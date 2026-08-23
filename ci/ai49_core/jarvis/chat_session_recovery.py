from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class ChatSessionRecoveryPolicy:
    """Sanitized contract fixture for retry ownership and zero user repair."""

    version: str
    user_retry_required: bool = False


def load_chat_session_recovery_policy(
    path: str | Path,
) -> ChatSessionRecoveryPolicy:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("synthetic recovery policy must be an object")
    version = raw.get("version")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("synthetic recovery policy requires version")
    if raw.get("user_retry_required") is not False:
        raise ValueError("synthetic recovery policy must keep user_retry_required=false")
    return ChatSessionRecoveryPolicy(version=version.strip())
