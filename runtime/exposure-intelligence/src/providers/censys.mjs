import { ExposureError, invariant } from "../errors.mjs";
import { DEFAULT_MAX_RESPONSE_BYTES, readBoundedJsonResponse } from "../http-response.mjs";
import { buildCensysPlan } from "../queries.mjs";
import { parseRetryAfter, sha256, stableStringify } from "../util.mjs";

function censysHttpError(response, now) {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers, now);
  if (status === 429) {
    return new ExposureError("Censys rate limit reached.", {
      code: "CENSYS_RATE_LIMITED",
      status,
      retryAfterMs: retryAfterMs ?? 60_000,
      failoverAllowed: true,
    });
  }
  if ([500, 502, 503, 504].includes(status)) {
    return new ExposureError("Censys returned a transient server error.", {
      code: "CENSYS_TRANSIENT_HTTP",
      status,
      retryAfterMs: retryAfterMs ?? 30_000,
      failoverAllowed: true,
    });
  }
  if ([401, 403].includes(status)) {
    return new ExposureError("Censys authentication or entitlement was rejected.", {
      code: "CENSYS_AUTH_OR_ENTITLEMENT",
      status,
      failoverAllowed: true,
    });
  }
  if (status === 402) {
    return new ExposureError("Censys credits are unavailable.", {
      code: "CENSYS_CREDITS_UNAVAILABLE",
      status,
      failoverAllowed: true,
    });
  }
  if ([400, 404, 422].includes(status)) {
    return new ExposureError("Censys rejected the deterministic asset query.", {
      code: "CENSYS_REQUEST_REJECTED",
      status,
      failoverAllowed: false,
    });
  }
  return new ExposureError("Censys returned an unexpected HTTP response.", {
    code: "CENSYS_HTTP_ERROR",
    status,
    failoverAllowed: false,
  });
}

export function createCensysProvider({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
  timeoutMs = 20_000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  return {
    name: "censys",
    hasCredential() {
      return typeof env.CENSYS_PLATFORM_TOKEN === "string" && env.CENSYS_PLATFORM_TOKEN.length > 0;
    },
    plan(asset, pageSize) {
      invariant(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100, "Censys page size must be between 1 and 100.", "INVALID_PAGE_SIZE");
      return buildCensysPlan(asset, pageSize);
    },
    async requestPage({ asset, cursor = null, pageSize = 100 }) {
      if (!this.hasCredential()) {
        throw new ExposureError("CENSYS_PLATFORM_TOKEN is not configured.", {
          code: "CENSYS_CREDENTIAL_MISSING",
          failoverAllowed: true,
        });
      }
      const plan = this.plan(asset, pageSize);
      const url = new URL(plan.endpoint);
      if (typeof env.CENSYS_ORGANIZATION_ID === "string" && env.CENSYS_ORGANIZATION_ID) {
        url.searchParams.set("organization_id", env.CENSYS_ORGANIZATION_ID);
      }
      const body = { query: plan.query, page_size: plan.pageSize };
      if (cursor) body.page_token = cursor;
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${env.CENSYS_PLATFORM_TOKEN}`,
            "content-type": "application/json",
          },
          body: stableStringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new ExposureError("Censys request outcome is ambiguous; automatic failover is blocked.", {
          code: "CENSYS_AMBIGUOUS_NETWORK",
          ambiguous: true,
          failoverAllowed: false,
          cause,
        });
      }
      if (!response.ok) throw censysHttpError(response, now);
      const { document, rawBytes } = await readBoundedJsonResponse(response, {
        provider: "censys",
        maxBytes: maxResponseBytes,
      });
      const result = document?.result;
      if (!result || !Array.isArray(result.hits)) {
        throw new ExposureError("Censys response schema did not contain result.hits.", {
          code: "CENSYS_SCHEMA_MISMATCH",
          status: response.status,
          ambiguous: true,
          failoverAllowed: false,
        });
      }
      const nextCursor = typeof result.next_page_token === "string" && result.next_page_token
        ? result.next_page_token
        : null;
      return {
        provider: "censys",
        plan,
        records: result.hits,
        nextCursor,
        rawHash: sha256(rawBytes),
        meta: {
          totalHits: Number.isFinite(result.total_hits) ? result.total_hits : null,
          queryDurationMs: Number.isFinite(result.query_duration_millis) ? result.query_duration_millis : null,
        },
      };
    },
  };
}
