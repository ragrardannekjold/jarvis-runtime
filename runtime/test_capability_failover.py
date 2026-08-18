import unittest

from capability_failover import (
    CapabilityError,
    CapabilityProvider,
    FailureKind,
    ProviderQuality,
    run_with_failover,
)


class CapabilityFailoverTests(unittest.TestCase):
    def test_api_units_exhaustion_switches_without_retry(self):
        calls = []

        def primary():
            calls.append("primary")
            raise CapabilityError(FailureKind.API_UNITS_EXHAUSTED, "Semrush units exhausted")

        result = run_with_failover([
            CapabilityProvider("semrush", primary),
            CapabilityProvider("web-primary-sources", lambda: {"ok": True}, verify=lambda v: v["ok"]),
        ])

        self.assertTrue(result.verified)
        self.assertEqual(result.provider, "web-primary-sources")
        self.assertEqual(calls, ["primary"])

    def test_transient_failure_retries_once_then_falls_back(self):
        count = {"primary": 0}

        def primary():
            count["primary"] += 1
            raise CapabilityError(FailureKind.TRANSIENT, "temporary 503")

        result = run_with_failover([
            CapabilityProvider("primary", primary),
            CapabilityProvider("fallback", lambda: "ok", verify=lambda value: value == "ok"),
        ])

        self.assertEqual(count["primary"], 2)
        self.assertEqual(result.provider, "fallback")
        self.assertEqual(result.status, "VERIFIED")

    def test_readback_failure_moves_to_next_provider(self):
        result = run_with_failover([
            CapabilityProvider("stale", lambda: "written", verify=lambda _value: False),
            CapabilityProvider("fresh", lambda: "written", verify=lambda value: value == "written"),
        ])

        self.assertEqual(result.provider, "fresh")
        self.assertTrue(any(e.outcome == "READBACK_FAILED" for e in result.evidence))

    def test_degraded_fallback_is_labeled_honestly(self):
        result = run_with_failover([
            CapabilityProvider(
                "quant-provider",
                lambda: (_ for _ in ()).throw(CapabilityError(FailureKind.QUOTA_EXHAUSTED, "quota")),
            ),
            CapabilityProvider(
                "qualitative-web",
                lambda: {"pricing": True},
                verify=lambda value: value["pricing"],
                quality=ProviderQuality.DEGRADED,
            ),
        ])

        self.assertEqual(result.status, "DEGRADED")
        self.assertEqual(result.degraded_reason, "FALLBACK_NOT_CAPABILITY_EQUIVALENT")

    def test_all_failures_return_failed_instead_of_raising(self):
        result = run_with_failover([
            CapabilityProvider(
                "a",
                lambda: (_ for _ in ()).throw(CapabilityError(FailureKind.FATAL, "bad config")),
            ),
            CapabilityProvider(
                "b",
                lambda: (_ for _ in ()).throw(CapabilityError(FailureKind.QUOTA_EXHAUSTED, "no units")),
            ),
        ])

        self.assertEqual(result.status, "FAILED")
        self.assertEqual(result.degraded_reason, "ALL_PROVIDERS_FAILED")
        self.assertIsNone(result.provider)


if __name__ == "__main__":
    unittest.main()
