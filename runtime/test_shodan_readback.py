import io
import json
import unittest
import urllib.error
from contextlib import redirect_stdout

from runtime.shodan_readback import ShodanReadbackError, build_public_receipt, run_cli, verify_shodan_api_key


SECRET = "shodan-test-key-never-print"


class FakeResponse:
    def __init__(self, payload, status=200):
        self.status = status
        self.payload = json.dumps(payload).encode("utf-8") if not isinstance(payload, bytes) else payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit):
        return self.payload[:limit]


def valid_payload():
    return {"plan": "paid-test-plan", "query_credits": 42, "scan_credits": 3, "monitored_ips": 1}


class ShodanReadbackTests(unittest.TestCase):
    def test_uses_only_api_info_and_keeps_internal_values(self):
        seen = []

        def open_url(request, timeout):
            seen.append((request.full_url, timeout))
            return FakeResponse(valid_payload())

        info = verify_shodan_api_key(SECRET, open_url=open_url)
        self.assertEqual(info.query_credits, 42)
        self.assertEqual(len(seen), 1)
        self.assertIn("https://api.shodan.io/api-info?", seen[0][0])
        self.assertNotIn("/shodan/host/", seen[0][0])

    def test_public_receipt_excludes_key_plan_and_exact_balances(self):
        info = verify_shodan_api_key(SECRET, open_url=lambda *_args, **_kwargs: FakeResponse(valid_payload()))
        encoded = json.dumps(build_public_receipt(info), sort_keys=True)
        self.assertNotIn(SECRET, encoded)
        self.assertNotIn("paid-test-plan", encoded)
        self.assertNotIn("42", encoded)
        self.assertTrue(json.loads(encoded)["query_capability_available"])
        self.assertEqual(json.loads(encoded)["query_credits_spent"], 0)

    def test_missing_key_stops_before_network(self):
        called = False

        def open_url(*_args, **_kwargs):
            nonlocal called
            called = True

        with self.assertRaisesRegex(ShodanReadbackError, "SHODAN_CREDENTIAL_MISSING"):
            verify_shodan_api_key("", open_url=open_url)
        self.assertFalse(called)

    def test_http_failure_is_sanitized(self):
        def open_url(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 401, "unauthorized", {}, None)

        with self.assertRaises(ShodanReadbackError) as raised:
            verify_shodan_api_key(SECRET, open_url=open_url)
        self.assertEqual(raised.exception.code, "SHODAN_AUTH_REJECTED")
        self.assertNotIn(SECRET, str(raised.exception))
        self.assertNotIn("https://", str(raised.exception))

    def test_cli_prints_only_redacted_receipt(self):
        output = io.StringIO()
        with redirect_stdout(output):
            code = run_cli({"SHODAN_API_KEY": SECRET}, open_url=lambda *_args, **_kwargs: FakeResponse(valid_payload()))
        self.assertEqual(code, 0)
        text = output.getvalue()
        self.assertNotIn(SECRET, text)
        self.assertNotIn("paid-test-plan", text)
        self.assertEqual(json.loads(text)["credential_status"], "VERIFIED")


if __name__ == "__main__":
    unittest.main()
