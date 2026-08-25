import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const TRACKING_PARAM_RE = /^(?:utm_.+|fbclid|gclid|yclid|mc_cid|mc_eid)$/i;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 4;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeHostname(hostname) {
  let normalized = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function isBlockedIp(hostname) {
  const value = normalizeHostname(hostname);
  const version = isIP(value);
  if (version === 4) {
    const parts = value.split(".").map(Number);
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  if (version === 6) {
    return value.startsWith("::ffff:")
      || value === "::1"
      || value === "::"
      || value.startsWith("fc")
      || value.startsWith("fd")
      || /^fe[89ab]/.test(value);
  }
  return false;
}

function assertPublicHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized
    || normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || isBlockedIp(normalized)) {
    throw new Error("non_public_hostname_rejected");
  }
  return normalized;
}

async function assertResolvedPublicHostname(hostname, lookupImpl) {
  const normalized = assertPublicHostname(hostname);
  if (isIP(normalized)) return;
  const result = await lookupImpl(normalized, { all: true, verbatim: true });
  const addresses = Array.isArray(result) ? result : [result];
  if (addresses.length === 0) throw new Error("dns_resolution_empty");
  for (const item of addresses) {
    const address = typeof item === "string" ? item : item?.address;
    if (!address || !isIP(normalizeHostname(address)) || isBlockedIp(address)) {
      throw new Error("non_public_dns_resolution_rejected");
    }
  }
}

function normalizeAllowedOrigins(allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0 || allowedOrigins.length > 32) {
    throw new Error("allowed_origins_required");
  }
  const origins = new Set();
  for (const raw of allowedOrigins) {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("invalid_allowed_origin");
    }
    assertPublicHostname(parsed.hostname);
    origins.add(parsed.origin);
  }
  return origins;
}

export function canonicalizePublicUrl(rawUrl, { allowedOrigins } = {}) {
  if (typeof rawUrl !== "string" || rawUrl.length < 8 || rawUrl.length > 4096) {
    throw new Error("invalid_url");
  }
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("https_url_required");
  }
  assertPublicHostname(parsed.hostname);
  const origins = normalizeAllowedOrigins(allowedOrigins);
  if (!origins.has(parsed.origin)) throw new Error("origin_not_allowlisted");

  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

function decodeBasicEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function normalizeDocumentText(body, contentType = "text/plain") {
  if (typeof body !== "string") throw new Error("body_must_be_text");
  let value = body;
  if (/html/i.test(contentType)) {
    value = value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    value = decodeBasicEntities(value);
  }
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function extractDocumentTitle(body, contentType = "text/plain") {
  if (!/html/i.test(contentType)) return null;
  const match = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = decodeBasicEntities(match[1]).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 500) : null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : null;
}

export function snapshotPublicDocument({
  url,
  status = 200,
  headers = {},
  body,
  fetchedAt = new Date().toISOString(),
}) {
  if (typeof body !== "string") throw new Error("body_must_be_text");
  const contentType = (headerValue(headers, "content-type") || "text/plain").split(";")[0].trim().toLowerCase();
  const normalizedText = normalizeDocumentText(body, contentType);
  return {
    schema_version: 1,
    url,
    fetched_at: fetchedAt,
    http_status: status,
    content_type: contentType,
    etag: headerValue(headers, "etag"),
    last_modified: headerValue(headers, "last-modified"),
    title: extractDocumentTitle(body, contentType),
    byte_length: Buffer.byteLength(body, "utf8"),
    raw_sha256: sha256(body),
    normalized_text_sha256: sha256(normalizedText),
    normalized_text_length: normalizedText.length,
  };
}

export function diffSnapshots(previous, current) {
  if (!previous || !current) throw new Error("two_snapshots_required");
  const rawChanged = previous.raw_sha256 !== current.raw_sha256;
  const semanticChanged = previous.normalized_text_sha256 !== current.normalized_text_sha256;
  return {
    schema_version: 1,
    url: current.url,
    changed: rawChanged || semanticChanged,
    semantic_changed: semanticChanged,
    title_changed: previous.title !== current.title,
    status_changed: previous.http_status !== current.http_status,
    byte_delta: current.byte_length - previous.byte_length,
    normalized_text_length_delta: current.normalized_text_length - previous.normalized_text_length,
    previous_sha256: previous.normalized_text_sha256,
    current_sha256: current.normalized_text_sha256,
  };
}

export async function harvestPublicUrl(rawUrl, {
  allowedOrigins,
  fetchImpl = globalThis.fetch,
  lookupImpl = dnsLookup,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch_implementation_required");
  if (typeof lookupImpl !== "function") throw new Error("dns_lookup_implementation_required");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 5_000_000) throw new Error("invalid_max_bytes");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("invalid_timeout_ms");
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 8) throw new Error("invalid_max_redirects");

  let currentUrl = canonicalizePublicUrl(rawUrl, { allowedOrigins });
  let response;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(currentUrl);
    await assertResolvedPublicHostname(parsed.hostname, lookupImpl);

    response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.1",
        "user-agent": "jarvis-runtime-evidence-harvester/1.1",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const location = response.headers?.get?.("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= maxRedirects) throw new Error("too_many_redirects");
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = canonicalizePublicUrl(nextUrl, { allowedOrigins });
      continue;
    }
    break;
  }

  if (!response) throw new Error("fetch_failed_without_response");

  const finalUrl = canonicalizePublicUrl(currentUrl, { allowedOrigins });
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("response_too_large");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error("response_too_large");
  const body = buffer.toString("utf8");

  return snapshotPublicDocument({
    url: finalUrl,
    status: response.status,
    headers: response.headers,
    body,
    fetchedAt: now().toISOString(),
  });
}
