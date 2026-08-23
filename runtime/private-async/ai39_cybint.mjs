const ALLOWED_ASN = "AS202279";
const ALLOWED_PAYLOAD_KEYS = new Set(["asn", "historical_reference_total"]);
const PROVIDER_TIMEOUT_MS = 45000;

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
      provider: "RIPEstat",
      status: "UNKNOWN",
      announced_prefix_count: null,
      routed: null,
    },
    shodan: {
      provider: "Shodan host/count",
      status: shodanKey ? "UNKNOWN" : "NO_SECRET",
      query_count: 0,
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
  const ripe = await getJson(ripeUrl, fetchImpl);
  if (ripe.body?.data && Array.isArray(ripe.body.data.prefixes)) {
    const count = ripe.body.data.prefixes.length;
    result.routing.status = "OK";
    result.routing.announced_prefix_count = count;
    result.routing.routed = count > 0;
  } else {
    result.routing.status = providerStatus(ripe);
  }

  if (shodanKey) {
    const shodanUrl = new URL("https://api.shodan.io/shodan/host/count");
    shodanUrl.searchParams.set("key", shodanKey);
    shodanUrl.searchParams.set("query", `asn:${config.asn}`);
    shodanUrl.searchParams.set("facets", "org:10,port:20,product:10,device:10");
    result.shodan.query_count = 1;
    const shodan = await getJson(shodanUrl, fetchImpl);
    if (shodan.body && typeof shodan.body === "object") {
      result.shodan.status = "OK";
      result.shodan.current_total = Number.isInteger(shodan.body.total) ? shodan.body.total : null;
      const facets = shodan.body.facets && typeof shodan.body.facets === "object" ? shodan.body.facets : {};
      result.shodan.org_facets = limitedFacets(facets.org, 10);
      result.shodan.port_facets = limitedFacets(facets.port, 20);
      result.shodan.product_facets = limitedFacets(facets.product, 10);
      result.shodan.device_facets = limitedFacets(facets.device, 10);
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

  const routingUseful = result.routing.status === "OK";
  const shodanUseful = result.shodan.status === "OK";
  result.evidence_status = routingUseful || shodanUseful ? "PARTIAL_EVIDENCE" : "INSUFFICIENT_DATA";

  return result;
}

export { ALLOWED_ASN, ALLOWED_PAYLOAD_KEYS, PROVIDER_TIMEOUT_MS };
