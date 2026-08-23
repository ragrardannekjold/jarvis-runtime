import test from "node:test";
import assert from "node:assert/strict";
import { runAi39CybintRefresh, validateAi39CybintPayload } from "./ai39_cybint.mjs";

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

test("AI-39 CYBINT payload is fixed to the allowlisted ASN", () => {
  assert.equal(validateAi39CybintPayload({}).asn, "AS202279");
  assert.throws(
    () => validateAi39CybintPayload({ asn: "AS12345" }),
    /asn_not_allowlisted/,
  );
  assert.throws(
    () => validateAi39CybintPayload({ asn: "AS202279", coordinates: [1, 2] }),
    /payload_key_not_allowlisted/,
  );
});

test("AI-39 CYBINT refresh uses one aggregate Shodan count request and retains no hosts", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("stat.ripe.net")) {
      return response(200, { data: { prefixes: Array.from({ length: 9 }, (_, i) => ({ prefix: `example-${i}` })) } });
    }
    if (String(url).includes("api.shodan.io/shodan/host/count")) {
      return response(200, {
        total: 15,
        facets: {
          org: [{ value: "Example Operator", count: 12 }],
          port: [{ value: 443, count: 7 }],
          product: [{ value: "nginx", count: 5 }],
          device: [],
        },
      });
    }
    throw new Error("unexpected_url");
  };

  const result = await runAi39CybintRefresh(
    { asn: "AS202279", historical_reference_total: 488 },
    { fetchImpl, shodanKey: "test-secret" },
  );

  assert.equal(result.routing.announced_prefix_count, 9);
  assert.equal(result.routing.routed, true);
  assert.equal(result.shodan.current_total, 15);
  assert.equal(result.shodan.query_count, 1);
  assert.equal(result.exposure_change_vs_reference.percent_change, -96.93);
  assert.equal(result.active_scan_performed, false);
  assert.equal(result.exact_hosts_retained, false);
  assert.equal(calls.filter((url) => url.includes("api.shodan.io/shodan/host/count")).length, 1);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("Shodan backpressure degrades only Shodan while preserving RIPE evidence", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("stat.ripe.net")) {
      return response(200, { data: { prefixes: [{}, {}, {}] } });
    }
    return response(429, {});
  };

  const result = await runAi39CybintRefresh(
    { historical_reference_total: 488 },
    { fetchImpl, shodanKey: "test-secret" },
  );
  assert.equal(result.routing.status, "OK");
  assert.equal(result.routing.announced_prefix_count, 3);
  assert.equal(result.shodan.status, "BACKPRESSURE");
  assert.equal(result.shodan.query_count, 1);
});
