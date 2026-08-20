import { ExposureError } from "../errors.mjs";
import { DEFAULT_MAX_RESPONSE_BYTES, readBoundedJsonResponse } from "../http-response.mjs";
import { buildNetlasPlan } from "../queries.mjs";
import { parseRetryAfter, sha256 } from "../util.mjs";

function netlasHttpError(response, now) {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers, now);
  if (status === 429) {
    return new ExposureError("Netlas rate limit reached.", {
      code: "NETLAS_RATE_LIMITED",
      status,
      retryAfterMs: retryAfterMs ?? 60_000,
      failoverAllowed: false,
    });
  }
  if (status === 402) {
    return new ExposureError("Netlas subscription coins are unavailable.", {
      code: "NETLAS_CREDITS_UNAVAILABLE",
      status,
      failoverAllowed: false,
    });
  }
  if ([500, 502, 503, 504].includes(status)) {
    return new ExposureError("Netlas returned a transient server error.", {
      code: "NETLAS_TRANSIENT_HTTP",
      status,
      retryAfterMs: retryAfterMs ?? 60_000,
      failoverAllowed: false,
    });
  }
  if ([401, 403].includes(status)) {
    return new ExposureError("Netlas authentication or entitlement was rejected.", {
      code: "NETLAS_AUTH_OR_ENTITLEMENT",
      status,
      failoverAllowed: false,
    });
  }
  if (status === 400) {
    return new ExposureError("Netlas rejected the deterministic asset query.", {
      code: "NETLAS_REQUEST_REJECTED",
      status,
      failoverAllowed: false,
    });
  }
  return new ExposureError("Netlas returned an unexpected HTTP response.", {
    code: "NETLAS_HTTP_ERROR",
    status,
    failoverAllowed: false,
  });
}

export function createNetlasProvider({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
  timeoutMs = 20_000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  return {
    name: "netlas",
    hasCredential() {
      return typeof env.NETLAS_API_KEY === "string" && env.NETLAS_API_KEY.length > 0;
    },
    plan(asset) {
      return buildNetlasPlan(asset);
    },
    async requestPage({ asset, cursor = 0 }) {
      if (!this.hasCredential()) {
        throw new ExposureError("NETLAS_API_KEY is not configured.", {
          code: "NETLAS_CREDENTIAL_MISSING",
          failoverAllowed: false,
        });
      }
      const start = cursor === null ? 0 : Number(cursor);
      if (!Number.isInteger(start) || start < 0 || start > 9980 || start % 20 !== 0) {
        throw new ExposureError("Netlas checkpoint offset is invalid.", { code: "INVALID_NETLAS_CURSOR" });
      }
      const plan = this.plan(asset);
      const url = new URL(plan.endpoint);
      url.searchParams.set("q", plan.query);
      url.searchParams.set("start", String(start));
      url.searchParams.set("fields", plan.fields);
      url.searchParams.set("source_type", "include");
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${env.NETLAS_API_KEY}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new ExposureError("Netlas request outcome is ambiguous; automatic continuation is blocked.", {
          code: "NETLAS_AMBIGUOUS_NETWORK",
          ambiguous: true,
          failoverAllowed: false,
          cause,
        });
      }
      if (!response.ok) throw netlasHttpError(response, now);
      const { document, rawBytes } = await readBoundedJsonResponse(response, {
        provider: "netlas",
        maxBytes: maxResponseBytes,
      });
      if (!Array.isArray(document?.items)) {
        throw new ExposureError("Netlas response schema did not contain items.", {
          code: "NETLAS_SCHEMA_MISMATCH",
          status: response.status,
          ambiguous: true,
          failoverAllowed: false,
        });
      }
      const next = start + 20;
      const knownTotal = Number.isFinite(document.total) ? document.total : null;
      const hasMore = document.items.length === 20 && next <= 9980 && (knownTotal === null || next < knownTotal);
      return {
        provider: "netlas",
        plan,
        records: document.items.map((item) => item?.data ?? item),
        nextCursor: hasMore ? next : null,
        rawHash: sha256(rawBytes),
        meta: {
          totalHits: knownTotal,
          start,
        },
      };
    },
  };
}
