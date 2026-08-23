const ALLOWED_ASN = "AS202279";
const ALLOWED_PAYLOAD_KEYS = new Set(["asn", "historical_reference_total"]);
const PROVIDER_TIMEOUT_MS = 45000;
const ROUTING_HISTORY_START = "2026-01-01T00:00:00Z";
const ROUTING_HISTORY_END = "2026-04-01T00:00:00Z";
const SHODAN_FACET_DEPTH = 100;
const INTEREST_NEIGHBOURS = [201776, 206810, 39089];

function assertFiniteNonNegativeNumber(value, name) {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid_${name}`);
  }
}

export function validateAi39CybintPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_ai39_cybint_payload");
  }
  const keys = Object.keys(payload);
  if (keys.some((key) => !ALLOWED_PAYLOAD_KEYS.has(key))) {
    throw new Error("ai39_cybint_payload_key_not_allowlisted");
  }
  const asn = payload.asn ?? ALLOWED_ASN;
  if (asn !== ALLOWED_ASN) throw new Error("ai39_cybint_asn_not_allowlisted");
  assertFiniteNonNegativeNumber(payload.historical_reference_total, "historical_reference_total");
  return {
    asn,
    historical_reference_total: payload.historical_reference_total ?? null,
  };
}

function limitedFacets(raw, limit) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, limit).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item.value;
    const count = item.count;
    if (!["string", "number"].includes(typeof value) || !Number.isInteger(count) || count < 0) {
      return [];
    }
    return [{ value: String(value), count }];
  });
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
    return {
      backpressure: false,
      status: null,
      body: null,
      transport_error: safeTransportCode(error),
    };
  }
  if (!response || typeof response.status !== "number") {
    return {
      backpressure: false,
      status: null,
      body: null,
      transport_error: "INVALID_RESPONSE",
    };
  }
  if (response.status === 429) {
    return { backpressure: true, status: 429, body: null, transport_error: null };
  }
  if (!response.ok) {
    return { backpressure: false, status: response.status, body: null, transport_error: null };
  }
  try {
    return {
      backpressure: false,
      status: response.status,
      body: await response.json(),
      transport_error: null,
    };
  } catch {
    return {
      backpressure: false,
      status: response.status,
      body: null,
      transport_error: "INVALID_JSON",
    };
  }
}

function providerStatus(observation) {
  if (observation.transport_error) return observation.transport_error;
  if (observation.backpressure) return "BACKPRESSURE";
  if (typeof observation.status === "number") return `HTTP_${observation.status}`;
  return "UNKNOWN";
}

function summarizeRoutingHistory(body) {
  const byOrigin = body?.data?.by_origin;
  if (!Array.isArray(byOrigin)) return null;
  const prefixes = new Set();
  let timelineSegments = 0;
  let prefixesWithMultipleSegments = 0;
  for (const origin of byOrigin) {
    if (!Array.isArray(origin?.prefixes)) continue;
    for (const item of origin.prefixes) {
      if (typeof item?.prefix === "string") prefixes.add(item.prefix);
      const timelines = Array.isArray(item?.timelines) ? item.timelines : [];
      timelineSegments += timelines.length;
      if (timelines.length > 1) prefixesWithMultipleSegments += 1;
    }
  }
  return {
    origins_seen_count: byOrigin.length,
    prefixes_seen_count: prefixes.size,
    timeline_segments: timelineSegments,
    prefixes_with_multiple_segments: prefixesWithMultipleSegments,
  };
}

function normalizeAsn(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.replace(/^AS/i, ""), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function summarizeNeighbourHistory(body) {
  const neighbours = body?.data?.neighbours;
  if (!Array.isArray(neighbours)) return null;
  const rows = new Map();
  for (const item of neighbours) {
    const asn = normalizeAsn(item?.neighbour ?? item?.asn);
    if (asn === null) continue;
    rows.set(asn, {
      asn,
      timeline_segments: Array.isArray(item?.timelines) ? item.timelines.length : 0,
    });
  }
  return {
    total_neighbours_seen_count: rows.size,
    interest_neighbours: INTEREST_NEIGHBOURS.map((asn) => ({
      asn,
      seen_in_window: rows.has(asn),
      timeline_segments: rows.get(asn)?.timeline_segments ?? 0,
    })),
  };
}

export async function runAi39CybintRefresh(
  payload = {},
  { fetchImpl = globalThis.fetch, shodanKey = process.env.SHODAN_API_KEY || "" } = {},
) {
  const config = validateAi39CybintPayload(payload);
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");

  const result = {
    schema_version: 1,
    source_class: "PASSIVE_CYBINT_AGGREGATE",
    asn: config.asn,
    collected_at: new Date().toISOString(),
    passive_only: true,
    active_scan_performed: false,
    exact_hosts_retained: false,
    exact_locations_retained: false,
    provider_failures_isolated: true,
    routing: {
      provider: "RIPEstat announced-prefixes",
      status: "UNKNOWN",
      announced_prefix_count: null,
      routed: null,
    },
    routing_history: {
      provider: "RIPEstat routing-history",
      status: "UNKNOWN",
      start_utc: ROUTING_HISTORY_START,
      end_utc: ROUTING_HISTORY_END,
      min_peers: 10,
      origins_seen_count: null,
      prefixes_seen_count: null,
      timeline_segments: null,
      prefixes_with_multiple_segments: null,
      exact_prefixes_retained: false,
    },
    neighbour_history: {
      provider: "RIPEstat asn-neighbours-history",
      status: "UNKNOWN",
      start_utc: ROUTING_HISTORY_START,
      end_utc: ROUTING_HISTORY_END,
      total_neighbours_seen_count: null,
      interest_neighbours: INTEREST_NEIGHBOURS.map((asn) => ({
        asn,
        seen_in_window: null,
        timeline_segments: null,
      })),
      exact_paths_retained: false,
    },
    shodan: {
      provider: "Shodan host/count",
      status: shodanKey ? "UNKNOWN" : "NO_SECRET",
      query_count: 0,
      facet_depth_requested: SHODAN_FACET_DEPTH,
      current_total: null,
      org_facets: [],
      port_facets: [],
      product_facets: [],
      device_facets: [],
    },
    historical_reference_total: config.historical_reference_total,
    exposure_change_vs_reference: null,
    evidence_status: "INSUFFICIENT_DATA",
    interpretation: "FACTS_ONLY_DIRECTIONAL_SCORING_EXTERNAL",
  };

  const ripeUrl = new URL("https://stat.ripe.net/data/announced-prefixes/data.json");
  ripeUrl.searchParams.set("resource", config.asn);
  ripeUrl.searchParams.set("sourceapp", "AI39Investigation");
  const ripe = await getJson(ripeUrl, fetchImpl);
  if (ripe.body?.data && Array.isArray(ripe.body.data.prefixes)) {
    const count = ripe.body.data.prefixes.length;
    result.routing.status = "OK";
    result.routing.announced_prefix_count = count;
    result.routing.routed = count > 0;
  } else {
    result.routing.status = providerStatus(ripe);
  }

  const historyUrl = new URL("https://stat.ripe.net/data/routing-history/data.json");
  historyUrl.searchParams.set("resource", config.asn);
  historyUrl.searchParams.set("starttime", ROUTING_HISTORY_START);
  historyUrl.searchParams.set("endtime", ROUTING_HISTORY_END);
  historyUrl.searchParams.set("min_peers", "10");
  historyUrl.searchParams.set("normalise_visibility", "true");
  historyUrl.searchParams.set("sourceapp", "AI39Investigation");
  const history = await getJson(historyUrl, fetchImpl);
  const historySummary = summarizeRoutingHistory(history.body);
  if (historySummary) {
    result.routing_history.status = "OK";
    Object.assign(result.routing_history, historySummary);
  } else {
    result.routing_history.status = providerStatus(history);
  }

  const neighbourUrl = new URL("https://stat.ripe.net/data/asn-neighbours-history/data.json");
  neighbourUrl.searchParams.set("resource", config.asn);
  neighbourUrl.searchParams.set("starttime", ROUTING_HISTORY_START);
  neighbourUrl.searchParams.set("endtime", ROUTING_HISTORY_END);
  neighbourUrl.searchParams.set("max_rows", "100");
  neighbourUrl.searchParams.set("sourceapp", "AI39Investigation");
  const neighbourHistory = await getJson(neighbourUrl, fetchImpl);
  const neighbourSummary = summarizeNeighbourHistory(neighbourHistory.body);
  if (neighbourSummary) {
    result.neighbour_history.status = "OK";
    Object.assign(result.neighbour_history, neighbourSummary);
  } else {
    result.neighbour_history.status = providerStatus(neighbourHistory);
  }

  if (shodanKey) {
    const shodanUrl = new URL("https://api.shodan.io/shodan/host/count");
    shodanUrl.searchParams.set("key", shodanKey);
    shodanUrl.searchParams.set("query", `asn:${config.asn}`);
    shodanUrl.searchParams.set(
      "facets",
      `org:${SHODAN_FACET_DEPTH},port:${SHODAN_FACET_DEPTH},product:${SHODAN_FACET_DEPTH},device:${SHODAN_FACET_DEPTH}`,
    );
    result.shodan.query_count = 1;
    const shodan = await getJson(shodanUrl, fetchImpl);
    if (shodan.body && typeof shodan.body === "object") {
      result.shodan.status = "OK";
      result.shodan.current_total = Number.isInteger(shodan.body.total) ? shodan.body.total : null;
      const facets = shodan.body.facets && typeof shodan.body.facets === "object" ? shodan.body.facets : {};
      result.shodan.org_facets = limitedFacets(facets.org, SHODAN_FACET_DEPTH);
      result.shodan.port_facets = limitedFacets(facets.port, SHODAN_FACET_DEPTH);
      result.shodan.product_facets = limitedFacets(facets.product, SHODAN_FACET_DEPTH);
      result.shodan.device_facets = limitedFacets(facets.device, SHODAN_FACET_DEPTH);
    } else {
      result.shodan.status = providerStatus(shodan);
    }
  }

  if (
    typeof result.historical_reference_total === "number" &&
    typeof result.shodan.current_total === "number"
  ) {
    const historical = result.historical_reference_total;
    const current = result.shodan.current_total;
    result.exposure_change_vs_reference = {
      absolute_change: current - historical,
      percent_change:
        historical > 0 ? Math.round(((current - historical) / historical) * 10000) / 100 : null,
    };
  }

  const useful = [
    result.routing.status,
    result.routing_history.status,
    result.neighbour_history.status,
    result.shodan.status,
  ].some((status) => status === "OK");
  result.evidence_status = useful ? "PARTIAL_EVIDENCE" : "INSUFFICIENT_DATA";

  return result;
}

export {
  ALLOWED_ASN,
  ALLOWED_PAYLOAD_KEYS,
  PROVIDER_TIMEOUT_MS,
  ROUTING_HISTORY_START,
  ROUTING_HISTORY_END,
  SHODAN_FACET_DEPTH,
  INTEREST_NEIGHBOURS,
};
