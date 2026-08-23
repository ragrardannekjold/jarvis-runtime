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

test("russia_external_control profile is fixed and caller cannot widen it", () => {
  assert.deepEqual(
    validateRtoComparePayload({ profile: "russia_external_control" }),
    { profile: "russia_external_control" },
  );
  assert.throws(
    () => validateRtoComparePayload({ profile: "russia_external_control", asns: [1] }),
    /payload_key_not_allowlisted/,
  );
});

test("russia_external_control uses only MTS, VimpelCom and MegaFon ASNs", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.includes("stat.ripe.net")) return response(200, { data: { prefixes: [{}] } });
    return response(200, trends([["2026-01", 1000], ["2026-08", 700]]));
  };
  const result = await runAi39RtoAsCompare(
    { profile: "russia_external_control" },
    { fetchImpl, shodanKey: "secret", paceMs: 0 },
  );
  assert.deepEqual(result.asns, ["AS8359", "AS3216", "AS31133"]);
  assert.equal(calls.filter((url) => url.includes("trends.shodan.io")).length, 3);
  assert.equal(result.rows.every((row) => row.shodan_trends.summary.first_to_latest_pct === -30), true);
  assert.equal(result.active_scan_performed, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
