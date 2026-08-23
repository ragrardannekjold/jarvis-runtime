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

test("trend profile selector is allowlisted and cannot accept arbitrary ASNs", () => {
  assert.deepEqual(validateRtoComparePayload({}), { profile: "rto_core" });
  assert.deepEqual(validateRtoComparePayload({ profile: "neighbour_control" }), { profile: "neighbour_control" });
  assert.throws(() => validateRtoComparePayload({ profile: "arbitrary" }), /profile_not_allowlisted/);
  assert.throws(() => validateRtoComparePayload({ asns: [1] }), /payload_key_not_allowlisted/);
});

test("rto_core compares exactly three fixed ASNs with one Shodan Trends request each", async () => {
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
    const query = new URL(text).searchParams.get("query");
    const asn = query.replace("asn:", "");
    return response(200, trends(monthly.get(asn)));
  };

  const result = await runAi39RtoAsCompare({}, { fetchImpl, shodanKey: "secret", paceMs: 0 });
  assert.equal(result.profile, "rto_core");
  assert.deepEqual(result.asns, ["AS202279", "AS204108", "AS214721"]);
  assert.equal(calls.filter((url) => url.includes("trends.shodan.io")).length, 3);
  assert.equal(result.rows[0].shodan_trends.summary.first_to_latest_pct, -96.93);
  assert.equal(result.active_scan_performed, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("neighbour_control uses only Miranda and two Ugletelecom ASNs", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.includes("stat.ripe.net")) return response(200, { data: { prefixes: [{}] } });
    return response(200, trends([["2026-01", 100], ["2026-08", 20]]));
  };
  const result = await runAi39RtoAsCompare(
    { profile: "neighbour_control" },
    { fetchImpl, shodanKey: "secret", paceMs: 0 },
  );
  assert.equal(result.profile, "neighbour_control");
  assert.deepEqual(result.asns, ["AS201776", "AS206810", "AS39089"]);
  assert.equal(calls.filter((url) => url.includes("trends.shodan.io")).length, 3);
  assert.equal(result.rows.every((row) => row.shodan_trends.summary.first_to_latest_pct === -80), true);
});

test("rate limiting one ASN does not fail the profile comparison", async () => {
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes("stat.ripe.net")) return response(200, { data: { prefixes: [{}] } });
    const query = new URL(text).searchParams.get("query");
    if (query === "asn:AS206810") return response(429, {});
    return response(200, trends([["2026-01", 10], ["2026-08", 20]]));
  };
  const result = await runAi39RtoAsCompare(
    { profile: "neighbour_control" },
    { fetchImpl, shodanKey: "secret", paceMs: 0 },
  );
  assert.equal(result.rows[1].shodan_trends.status, "BACKPRESSURE");
  assert.equal(result.rows[0].shodan_trends.status, "OK");
  assert.equal(result.rows[2].shodan_trends.status, "OK");
  assert.equal(result.evidence_status, "PARTIAL_EVIDENCE");
});
