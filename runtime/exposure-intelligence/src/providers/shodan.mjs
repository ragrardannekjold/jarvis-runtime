import { ExposureError } from "../errors.mjs";
import { DEFAULT_MAX_RESPONSE_BYTES, readBoundedJsonResponse } from "../http-response.mjs";
import { buildShodanPlan } from "../queries.mjs";
import { parseRetryAfter, sha256 } from "../util.mjs";

function shodanHttpError(response, now) {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers, now);
  if (status === 429) return new ExposureError("Shodan rate limit reached.", { code: "SHODAN_RATE_LIMITED", status, retryAfterMs: retryAfterMs ?? 60_000, failoverAllowed: true });
  if ([500, 502, 503, 504].includes(status)) return new ExposureError("Shodan returned a transient server error.", { code: "SHODAN_TRANSIENT_HTTP", status, retryAfterMs: retryAfterMs ?? 30_000, failoverAllowed: true });
  if ([401, 403].includes(status)) return new ExposureError("Shodan authentication or entitlement was rejected.", { code: "SHODAN_AUTH_OR_ENTITLEMENT", status, failoverAllowed: true });
  if (status === 402) return new ExposureError("Shodan query credits are unavailable.", { code: "SHODAN_CREDITS_UNAVAILABLE", status, failoverAllowed: true });
  if ([400, 404, 422].includes(status)) return new ExposureError("Shodan rejected the deterministic asset query.", { code: "SHODAN_REQUEST_REJECTED", status, failoverAllowed: false });
  return new ExposureError("Shodan returned an unexpected HTTP response.", { code: "SHODAN_HTTP_ERROR", status, failoverAllowed: false });
}

async function fetchPreflight(fetchImpl, url, options, { now, maxResponseBytes }) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (cause) {
    throw new ExposureError("Shodan no-credit preflight was unavailable.", { code: "SHODAN_PREFLIGHT_UNAVAILABLE", failoverAllowed: true, cause });
  }
  if (!response.ok) throw shodanHttpError(response, now);
  try {
    return await readBoundedJsonResponse(response, { provider: "shodan", maxBytes: maxResponseBytes });
  } catch (cause) {
    throw new ExposureError("Shodan no-credit preflight response was invalid.", { code: "SHODAN_PREFLIGHT_RESPONSE_INVALID", status: response.status, failoverAllowed: true, cause });
  }
}

export function createShodanProvider({ fetchImpl = globalThis.fetch, env = process.env, now = Date.now, timeoutMs = 20_000, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  return {
    name: "shodan",
    hasCredential() {
      return typeof env.SHODAN_API_KEY === "string" && env.SHODAN_API_KEY.length > 0;
    },
    plan(asset) {
      return buildShodanPlan(asset);
    },
    async requestPage({ asset, cursor = null }) {
      if (!this.hasCredential()) throw new ExposureError("SHODAN_API_KEY is not configured.", { code: "SHODAN_CREDENTIAL_MISSING", failoverAllowed: true });
      const plan = this.plan(asset);
      const options = { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) };
      const context = { now, maxResponseBytes };

      const countUrl = new URL("https://api.shodan.io/shodan/host/count");
      countUrl.searchParams.set("key", env.SHODAN_API_KEY);
      countUrl.searchParams.set("query", plan.query);
      const count = await fetchPreflight(fetchImpl, countUrl, options, context);
      if (!Number.isSafeInteger(count.document?.total) || count.document.total < 0) throw new ExposureError("Shodan count preflight did not return a valid total.", { code: "SHODAN_PREFLIGHT_SCHEMA_MISMATCH", failoverAllowed: true });
      if (count.document.total === 0) {
        return { provider: "shodan", plan, records: [], nextCursor: null, rawHash: sha256(count.rawBytes), meta: { totalHits: 0, queryCreditsSpent: 0, queryCreditsBefore: null } };
      }

      const infoUrl = new URL("https://api.shodan.io/api-info");
      infoUrl.searchParams.set("key", env.SHODAN_API_KEY);
      const info = await fetchPreflight(fetchImpl, infoUrl, options, context);
      const queryCredits = info.document?.query_credits;
      if (!Number.isSafeInteger(queryCredits) || queryCredits < 0) throw new ExposureError("Shodan API plan did not return a valid query-credit balance.", { code: "SHODAN_PREFLIGHT_SCHEMA_MISMATCH", failoverAllowed: true });
      if (queryCredits < plan.queryCreditsPerPage) throw new ExposureError("Shodan query-credit balance is insufficient for the planned page.", { code: "SHODAN_CREDITS_UNAVAILABLE", failoverAllowed: true });

      const page = cursor === null ? 1 : Number(cursor);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new ExposureError("Shodan page cursor is invalid.", { code: "SHODAN_CURSOR_INVALID", failoverAllowed: false });
      const searchUrl = new URL(plan.endpoint);
      searchUrl.searchParams.set("key", env.SHODAN_API_KEY);
      searchUrl.searchParams.set("query", plan.query);
      searchUrl.searchParams.set("page", String(page));
      searchUrl.searchParams.set("minify", "false");
      let response;
      try {
        response = await fetchImpl(searchUrl, options);
      } catch (cause) {
        throw new ExposureError("Shodan search outcome is ambiguous; automatic failover is blocked.", {
          code: "SHODAN_AMBIGUOUS_NETWORK",
          ambiguous: true,
          failoverAllowed: false,
          details: { creditAccounting: "UNKNOWN_0_OR_1", queryCreditsBefore: queryCredits },
          cause,
        });
      }
      if ([500, 502, 503, 504].includes(response.status)) {
        throw new ExposureError("Shodan search may have been accepted before a server failure; automatic failover is blocked.", {
          code: "SHODAN_AMBIGUOUS_SERVER_RESPONSE",
          status: response.status,
          ambiguous: true,
          failoverAllowed: false,
          details: { creditAccounting: "UNKNOWN_0_OR_1", queryCreditsBefore: queryCredits },
        });
      }
      if (!response.ok) throw shodanHttpError(response, now);
      const { document, rawBytes } = await readBoundedJsonResponse(response, { provider: "shodan", maxBytes: maxResponseBytes });
      if (!Array.isArray(document?.matches) || !Number.isSafeInteger(document?.total) || document.total < 0) throw new ExposureError("Shodan response schema did not contain matches and total.", { code: "SHODAN_SCHEMA_MISMATCH", status: response.status, ambiguous: true, failoverAllowed: false });
      const nextCursor = document.matches.length === plan.pageSize && page * plan.pageSize < document.total ? page + 1 : null;
      return {
        provider: "shodan",
        plan,
        records: document.matches,
        nextCursor,
        rawHash: sha256(rawBytes),
        meta: { totalHits: document.total, queryCreditsSpent: plan.queryCreditsPerPage, queryCreditsBefore: queryCredits },
      };
    },
  };
}
