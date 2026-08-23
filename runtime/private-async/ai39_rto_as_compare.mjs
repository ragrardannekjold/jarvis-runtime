const TREND_PROFILES = Object.freeze({
  rto_core: [202279, 204108, 214721],
  neighbour_control: [201776, 206810, 39089],
  allied_external_control: [3320, 2856, 7018],
});
const TREND_START = "2026-01";
const PROVIDER_TIMEOUT_MS = 45000;
const SHODAN_PACE_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeTransportCode(error) {
  const name = typeof error?.name === "string" ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "TIMEOUT";
  return "NETWORK_ERROR";
}

async function getJson(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
        : undefined,
    });
  } catch (error) {
    return { status: null, body: null, transport_error: safeTransportCode(error), backpressure: false };
  }
  if (!response || typeof response.status !== "number") {
    return { status: null, body: null, transport_error: "INVALID_RESPONSE", backpressure: false };
  }
  if (response.status === 429) {
    return { status: 429, body: null, transport_error: null, backpressure: true };
  }
  if (!response.ok) {
    return { status: response.status, body: null, transport_error: null, backpressure: false };
  }
  try {
    return { status: response.status, body: await response.json(), transport_error: null, backpressure: false };
  } catch {
    return { status: response.status, body: null, transport_error: "INVALID_JSON", backpressure: false };
  }
}

function statusOf(observation) {
  if (observation.transport_error) return observation.transport_error;
  if (observation.backpressure) return "BACKPRESSURE";
  if (typeof observation.status === "number") return `HTTP_${observation.status}`;
  return "UNKNOWN";
}

function normalizeMonthly(body) {
  if (!Array.isArray(body?.matches)) return [];
  return body.matches
    .flatMap((item) => {
      if (typeof item?.month !== "string") return [];
      if (!(typeof item?.count === "number" && Number.isFinite(item.count))) return [];
      return [{ month: item.month, count: Math.max(0, Math.round(item.count)) }];
    })
    .filter((item) => item.month >= TREND_START)
    .sort((a, b) => a.month.localeCompare(b.month));
}

function trendSummary(monthly) {
  if (!Array.isArray(monthly) || monthly.length === 0) {
    return {
      first_month: null,
      first_count: null,
      latest_month: null,
      latest_count: null,
      first_to_latest_change: null,
      first_to_latest_pct: null,
      peak_month: null,
      peak_count: null,
    };
  }
  const first = monthly[0];
  const latest = monthly.at(-1);
  const peak = monthly.reduce((best, item) => item.count > best.count ? item : best, monthly[0]);
  return {
    first_month: first.month,
    first_count: first.count,
    latest_month: latest.month,
    latest_count: latest.count,
    first_to_latest_change: latest.count - first.count,
    first_to_latest_pct:
      first.count > 0 ? Math.round(((latest.count - first.count) / first.count) * 10000) / 100 : null,
    peak_month: peak.month,
    peak_count: peak.count,
  };
}

export function validateRtoComparePayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_rto_compare_payload");
  }
  const keys = Object.keys(payload);
  if (keys.some((key) => key !== "profile")) throw new Error("rto_compare_payload_key_not_allowlisted");
  const profile = payload.profile ?? "rto_core";
  if (!Object.hasOwn(TREND_PROFILES, profile)) throw new Error("rto_compare_profile_not_allowlisted");
  return { profile };
}

export async function runAi39RtoAsCompare(
  payload = {},
  {
    fetchImpl = globalThis.fetch,
    shodanKey = process.env.SHODAN_API_KEY || "",
    paceMs = SHODAN_PACE_MS,
  } = {},
) {
  const config = validateRtoComparePayload(payload);
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
  const asns = TREND_PROFILES[config.profile];

  const result = {
    schema_version: 1,
    source_class: "PASSIVE_CYBINT_MULTI_AS_AGGREGATE",
    collected_at: new Date().toISOString(),
    profile: config.profile,
    asns: asns.map((asn) => `AS${asn}`),
    passive_only: true,
    active_scan_performed: false,
    exact_hosts_retained: false,
    exact_prefixes_retained: false,
    exact_locations_retained: false,
    provider_failures_isolated: true,
    trend_start: TREND_START,
    rows: [],
    evidence_status: "INSUFFICIENT_DATA",
    interpretation: "FACTS_ONLY_NO_AUTOMATIC_MIGRATION_OR_CONTROL_ATTRIBUTION",
  };

  for (let index = 0; index < asns.length; index += 1) {
    const asn = asns[index];
    const row = {
      asn: `AS${asn}`,
      routing: {
        provider: "RIPEstat announced-prefixes",
        status: "UNKNOWN",
        announced_prefix_count: null,
        routed: null,
      },
      shodan_trends: {
        provider: "Shodan Trends",
        status: shodanKey ? "UNKNOWN" : "NO_SECRET",
        query_count: 0,
        total: null,
        monthly_2026: [],
        summary: trendSummary([]),
      },
    };

    const ripeUrl = new URL("https://stat.ripe.net/data/announced-prefixes/data.json");
    ripeUrl.searchParams.set("resource", `AS${asn}`);
    ripeUrl.searchParams.set("sourceapp", "AI39Investigation");
    const ripe = await getJson(ripeUrl, fetchImpl);
    if (Array.isArray(ripe.body?.data?.prefixes)) {
      row.routing.status = "OK";
      row.routing.announced_prefix_count = ripe.body.data.prefixes.length;
      row.routing.routed = ripe.body.data.prefixes.length > 0;
    } else {
      row.routing.status = statusOf(ripe);
    }

    if (shodanKey) {
      if (index > 0 && paceMs > 0) await sleep(paceMs);
      const trendsUrl = new URL("https://trends.shodan.io/api/v1/search");
      trendsUrl.searchParams.set("key", shodanKey);
      trendsUrl.searchParams.set("query", `asn:AS${asn}`);
      row.shodan_trends.query_count = 1;
      const trends = await getJson(trendsUrl, fetchImpl);
      if (trends.body && typeof trends.body === "object") {
        row.shodan_trends.status = "OK";
        row.shodan_trends.total = typeof trends.body.total === "number" ? trends.body.total : null;
        row.shodan_trends.monthly_2026 = normalizeMonthly(trends.body);
        row.shodan_trends.summary = trendSummary(row.shodan_trends.monthly_2026);
      } else {
        row.shodan_trends.status = statusOf(trends);
      }
    }

    result.rows.push(row);
  }

  result.evidence_status = result.rows.some(
    (row) => row.routing.status === "OK" || row.shodan_trends.status === "OK",
  ) ? "PARTIAL_EVIDENCE" : "INSUFFICIENT_DATA";

  return result;
}

export { TREND_PROFILES, TREND_START, PROVIDER_TIMEOUT_MS, SHODAN_PACE_MS };
