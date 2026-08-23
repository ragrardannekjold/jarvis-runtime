import test from "node:test";
import assert from "node:assert/strict";
import { runAi39RtoAsCompare, validateRtoComparePayload } from "./ai39_rto_as_compare.mjs";

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

function trends(months) {
  return { total: 999, matches: months.map(([month, count]) => ({ month, count })) };
}

test("RTO compare payload is intentionally empty and target set is fixed", () => {
  assert.deepEqual(validateRtoComparePayload({}), {});
  assert.throws(() => validateRtoComparePayload({ asns: [1] }), /must_be_empty/);
});

test("compares exactly three fixed ASNs with one Shodan Trends request each", async () => {
  const calls = [];
  const monthly = new Map([
    ["AS202279", [["2026-01", 488], ["2026-02", 107], ["2026-03", 14], ["2026-08", 15]]],
    ["AS204108", [["2026-01", 20], ["2026-03", 40], ["2026-08", 80]]],
    ["AS214721", [["2026-01", 5], ["2026-03", 25], ["2026-08", 50]]],
  ]);

  const fetchImpl = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.includes("stat.ripe.net")) {
      const resource = new URL(text).searchParams.get("resource");
      const count = resource === "AS202279" ? 9 : resource === "AS204108" ? 6 : 2;
      return response(200, { data: { prefixes: Array.from({ length: count }, () => ({})) } });
    }
    if (text.includes("trends.shodan.io")) {
      const query = new URL(text).searchParams.get("query");
      const asn = query.replace("asn:", "");
      return response(200, trends(monthly.get(asn)));
    }
    throw new Error("unexpected_url");
  };

  const result = await runAi39RtoAsCompare({}, { fetchImpl, shodanKey: "secret", paceMs: 0 });
  assert.deepEqual(result.asns, ["AS202279", "AS204108", "AS214721"]);
  assert.equal(result.rows.length, 3);
  assert.equal(calls.filter((url) => url.includes("trends.shodan.io")).length, 3);
  assert.equal(result.rows[0].shodan_trends.summary.first_count, 488);
  assert.equal(result.rows[0].shodan_trends.summary.latest_count, 15);
  assert.equal(result.rows[0].shodan_trends.summary.first_to_latest_pct, -96.93);
  assert.equal(result.rows[1].shodan_trends.summary.first_to_latest_pct, 300);
  assert.equal(result.rows[2].shodan_trends.summary.first_to_latest_pct, 900);
  assert.equal(result.active_scan_performed, false);
  assert.equal(result.exact_hosts_retained, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("rate limiting one ASN does not fail the multi-AS comparison", async () => {
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes("stat.ripe.net")) return response(200, { data: { prefixes: [{}] } });
    const query = new URL(text).searchParams.get("query");
    if (query === "asn:AS204108") return response(429, {});
    return response(200, trends([["2026-01", 10], ["2026-08", 20]]));
  };
  const result = await runAi39RtoAsCompare({}, { fetchImpl, shodanKey: "secret", paceMs: 0 });
  assert.equal(result.rows[1].shodan_trends.status, "BACKPRESSURE");
  assert.equal(result.rows[0].shodan_trends.status, "OK");
  assert.equal(result.rows[2].shodan_trends.status, "OK");
  assert.equal(result.evidence_status, "PARTIAL_EVIDENCE");
});
