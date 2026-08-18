from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Generic, Sequence, TypeVar

T = TypeVar("T")


class FailureKind(str, Enum):
    API_UNITS_EXHAUSTED = "API_UNITS_EXHAUSTED"
    QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED"
    RATE_LIMITED = "RATE_LIMITED"
    TRANSIENT = "TRANSIENT"
    UNAVAILABLE = "UNAVAILABLE"
    AUTH_UNAVAILABLE = "AUTH_UNAVAILABLE"
    READBACK_FAILED = "READBACK_FAILED"
    FATAL = "FATAL"


class ProviderQuality(str, Enum):
    EQUIVALENT = "EQUIVALENT"
    DEGRADED = "DEGRADED"


@dataclass(frozen=True)
class CapabilityError(Exception):
    kind: FailureKind
    detail: str

    def __str__(self) -> str:
        return f"{self.kind.value}: {self.detail}"


@dataclass(frozen=True)
class CapabilityProvider(Generic[T]):
    name: str
    execute: Callable[[], T]
    verify: Callable[[T], bool] | None = None
    quality: ProviderQuality = ProviderQuality.EQUIVALENT


@dataclass(frozen=True)
class AttemptEvidence:
    provider: str
    attempt: int
    outcome: str
    failure_kind: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class FailoverResult(Generic[T]):
    status: str
    provider: str | None
    value: T | None
    evidence: tuple[AttemptEvidence, ...] = field(default_factory=tuple)
    degraded_reason: str | None = None

    @property
    def verified(self) -> bool:
        return self.status == "VERIFIED"


_RETRYABLE = {
    FailureKind.RATE_LIMITED,
    FailureKind.TRANSIENT,
    FailureKind.UNAVAILABLE,
}


def classify_exception(exc: BaseException) -> FailureKind:
    if isinstance(exc, CapabilityError):
        return exc.kind

    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(exc, "status", None)

    if status == 429:
        return FailureKind.RATE_LIMITED
    if status in {408, 425, 500, 502, 503, 504}:
        return FailureKind.TRANSIENT
    if status in {401, 403}:
        return FailureKind.AUTH_UNAVAILABLE

    text = str(exc).upper()
    if "API_UNITS_EXHAUSTED" in text or "API UNITS" in text:
        return FailureKind.API_UNITS_EXHAUSTED
    if "QUOTA" in text or "LIMIT EXCEEDED" in text:
        return FailureKind.QUOTA_EXHAUSTED
    if "RATE LIMIT" in text:
        return FailureKind.RATE_LIMITED
    if "UNAVAILABLE" in text or "OUTAGE" in text:
        return FailureKind.UNAVAILABLE
    return FailureKind.FATAL


def run_with_failover(
    providers: Sequence[CapabilityProvider[T]],
    *,
    transient_retry_max: int = 1,
) -> FailoverResult[T]:
    """Run a capability through ordered providers without stopping the parent loop.

    The function never spins indefinitely: each provider gets one initial attempt plus at
    most ``transient_retry_max`` retries, and only retryable failures are retried.
    A successful provider is accepted only after its readback verifier passes.
    """
    if transient_retry_max < 0:
        raise ValueError("transient_retry_max must be >= 0")
    if not providers:
        return FailoverResult(
            status="FAILED",
            provider=None,
            value=None,
            evidence=(),
            degraded_reason="NO_PROVIDERS_CONFIGURED",
        )

    evidence: list[AttemptEvidence] = []

    for provider in providers:
        retry_count = 0
        attempt = 0

        while True:
            attempt += 1
            try:
                value = provider.execute()
            except BaseException as exc:  # provider adapters can wrap foreign SDK errors
                kind = classify_exception(exc)
                evidence.append(
                    AttemptEvidence(
                        provider=provider.name,
                        attempt=attempt,
                        outcome="EXECUTION_FAILED",
                        failure_kind=kind.value,
                        detail=str(exc),
                    )
                )
                if kind in _RETRYABLE and retry_count < transient_retry_max:
                    retry_count += 1
                    continue
                break

            if provider.verify is not None:
                try:
                    verified = bool(provider.verify(value))
                except BaseException as exc:
                    evidence.append(
                        AttemptEvidence(
                            provider=provider.name,
                            attempt=attempt,
                            outcome="READBACK_FAILED",
                            failure_kind=FailureKind.READBACK_FAILED.value,
                            detail=str(exc),
                        )
                    )
                    break
                if not verified:
                    evidence.append(
                        AttemptEvidence(
                            provider=provider.name,
                            attempt=attempt,
                            outcome="READBACK_FAILED",
                            failure_kind=FailureKind.READBACK_FAILED.value,
                            detail="readback verifier returned false",
                        )
                    )
                    break

            evidence.append(
                AttemptEvidence(
                    provider=provider.name,
                    attempt=attempt,
                    outcome="VERIFIED",
                )
            )
            if provider.quality is ProviderQuality.DEGRADED:
                return FailoverResult(
                    status="DEGRADED",
                    provider=provider.name,
                    value=value,
                    evidence=tuple(evidence),
                    degraded_reason="FALLBACK_NOT_CAPABILITY_EQUIVALENT",
                )
            return FailoverResult(
                status="VERIFIED",
                provider=provider.name,
                value=value,
                evidence=tuple(evidence),
            )

    return FailoverResult(
        status="FAILED",
        provider=None,
        value=None,
        evidence=tuple(evidence),
        degraded_reason="ALL_PROVIDERS_FAILED",
    )
