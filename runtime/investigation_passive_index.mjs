import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readBoundedJsonResponse } from "./exposure-intelligence/src/http-response.mjs";

const CAPABILITY = "investigation.passive_index_search";
const HISTORY_CAPABILITY = "investigation.passive_index_history_recovery";
const PURPOSE = "BANDEROL_SCALING_PUBLIC_PERIMETER_BASELINE";
const HISTORY_PURPOSE = "SHODAN_HISTORY_RECEIPT_REMEDIATION";
const MAX_ANCHORS = 4;
const PAGE_SIZE = 50;
const MAX_HISTORY_HOSTS = 2;
const MAX_HISTORY_RECORDS_PER_HOST = 25;
const MIN_EXECUTION_HEADROOM_MS = 5 * 60_000;
const MAX_COUNT_BYTES = 64 * 1024;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const SHODAN_ORIGIN = "https://api.shodan.io";
const SEARCH_FIELDS = [
  "ip_str", "port", "transport", "timestamp", "product", "version", "cpe", "cpe23",
  "hostnames", "ssl.cert.fingerprint", "ssh.fingerprint", "http.favicon.hash", "hash", "vulns",
  "_shodan.module",
];

export class PassiveIndexError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "PassiveIndexError";
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function assertExactKeys(document, allowed, code) {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new PassiveIndexError(code, "Expected an object.");
  }
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) throw new PassiveIndexError(code, "Unsupported field.");
  }
}

function parseTimestamp(value, fieldName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new PassiveIndexError("PASSIVE_INDEX_TIME_INVALID", `${fieldName} must be an ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PassiveIndexError("PASSIVE_INDEX_TIME_INVALID", `${fieldName} must be an ISO timestamp.`);
  }
  return parsed;
}

function normalizeDomain(value) {
  if (typeof value !== "string") {
    throw new PassiveIndexError("PASSIVE_INDEX_ANCHOR_INVALID", "Domain anchor must be a string.");
  }
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
    || !domain.includes(".")
    || domain.includes("..")
    || domain.split(".").some((label) => label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    throw new PassiveIndexError("PASSIVE_INDEX_ANCHOR_INVALID", "Domain anchor was invalid.");
  }
  return domain;
}

function validateSource(source, entityId, anchorValue) {
  assertExactKeys(source, new Set(["publisher", "url"]), "PASSIVE_INDEX_SOURCE_INVALID");
  if (typeof source.publisher !== "string" || typeof source.url !== "string") throw new PassiveIndexError("PASSIVE_INDEX_SOURCE_INVALID", "Source fields were invalid.");
  let parsed;
  try {
    parsed = new URL(source.url);
  } catch {
    throw new PassiveIndexError("PASSIVE_INDEX_SOURCE_INVALID", "Authoritative source URL was invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new PassiveIndexError("PASSIVE_INDEX_SOURCE_INVALID", "Authoritative source URL was not allowlisted.");
  }
  if (entityId === "DOCUMENTATION_EXAMPLE_1") {
    if (source.publisher !== "IANA_RESERVED"
      || parsed.hostname !== "www.iana.org"
      || parsed.pathname !== "/help/example-domains"
      || anchorValue !== "example.com") {
      throw new PassiveIndexError("PASSIVE_INDEX_SOURCE_INVALID", "Documentation source was invalid.");
    }
    return { publisher: source.publisher, url: parsed.toString() };
  }
  if (source.publisher !== "HUR_WAR_SANCTIONS" || parsed.hostname !== "war-sanctions.gur.gov.ua") {
    throw new PassiveIndexError("PASSIVE_INDEX_SOURCE_INVALID", "Only the configured authoritative source is accepted.");
  }
  const match = /^\/en\/components\/companies\/(\d+)\/?$/.exec(parsed.pathname);
  if (!match || entityId !== `HUR_COMPANY_${match[1]}`) {
    throw new PassiveIndexError("PASSIVE_INDEX_SOURCE_INVALID", "Source record did not match the entity anchor.");
  }
  return { publisher: source.publisher, url: parsed.toString() };
}

function validateAnchor(anchor) {
  assertExactKeys(anchor, new Set(["anchor_id", "entity_id", "kind", "value", "source"]), "PASSIVE_INDEX_ANCHOR_INVALID");
  if (typeof anchor.anchor_id !== "string" || !/^[A-Z0-9][A-Z0-9_-]{4,63}$/.test(anchor.anchor_id)) {
    throw new PassiveIndexError("PASSIVE_INDEX_ANCHOR_INVALID", "Anchor identifier was invalid.");
  }
  if (typeof anchor.entity_id !== "string"
    || !/^(?:HUR_COMPANY_\d{1,10}|DOCUMENTATION_EXAMPLE_1)$/.test(anchor.entity_id)) {
    throw new PassiveIndexError("PASSIVE_INDEX_ANCHOR_INVALID", "Entity identifier was invalid.");
  }
  if (anchor.kind !== "domain") {
    throw new PassiveIndexError("PASSIVE_INDEX_ANCHOR_INVALID", "Only exact public-domain anchors are accepted.");
  }
  const value = normalizeDomain(anchor.value);
  return { ...anchor, value, source: validateSource(anchor.source, anchor.entity_id, value) };
}

export function validatePassiveIndexTask(document, filename, { now = Date.now, allowExpired = false } = {}) {
  assertExactKeys(document, new Set([
    "schema_version", "task_id", "project_id", "capability", "mode", "provider", "purpose",
    "anchors", "collection", "max_provider_requests", "max_query_credits", "created_at",
    "expires_at", "runtime_context_binding_sha256", "authorization",
  ]), "PASSIVE_INDEX_SCHEMA_INVALID");
  if (document.schema_version !== 2) throw new PassiveIndexError("PASSIVE_INDEX_SCHEMA_INVALID", "Unsupported task schema.");
  if (typeof document.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,80}$/.test(document.task_id)) {
    throw new PassiveIndexError("PASSIVE_INDEX_TASK_ID_INVALID", "Task identifier was invalid.");
  }
  if (filename !== `${document.task_id}.json`) throw new PassiveIndexError("PASSIVE_INDEX_TASK_ID_MISMATCH", "Task filename did not match its identifier.");
  if (document.project_id !== "KYIV") throw new PassiveIndexError("PASSIVE_INDEX_PROJECT_ID_INVALID", "This pilot is isolated to the KYIV project.");
  if (document.capability !== CAPABILITY || document.mode !== "passive_private_enrichment"
    || document.provider !== "shodan" || document.purpose !== PURPOSE) {
    throw new PassiveIndexError("PASSIVE_INDEX_CAPABILITY_INVALID", "Task was outside the bounded passive capability.");
  }
  if (!Array.isArray(document.anchors) || document.anchors.length < 1 || document.anchors.length > MAX_ANCHORS) {
    throw new PassiveIndexError("PASSIVE_INDEX_ANCHOR_INVALID", "One to four public anchors are required.");
  }
  const anchors = document.anchors.map(validateAnchor);
  if (new Set(anchors.map((anchor) => anchor.anchor_id)).size !== anchors.length
    || new Set(anchors.map((anchor) => anchor.value)).size !== anchors.length) {
    throw new PassiveIndexError("PASSIVE_INDEX_ANCHOR_INVALID", "Duplicate anchors are not accepted.");
  }
  assertExactKeys(document.collection, new Set(["page_size", "max_pages", "max_history_hosts", "raw_banner_persisted"]), "PASSIVE_INDEX_COLLECTION_INVALID");
  if (document.collection.page_size !== PAGE_SIZE || document.collection.max_pages !== 1
    || document.collection.max_history_hosts !== MAX_HISTORY_HOSTS || document.collection.raw_banner_persisted !== false) {
    throw new PassiveIndexError("PASSIVE_INDEX_COLLECTION_INVALID", "Collection bounds were invalid.");
  }
  const expectedRequests = (anchors.length * 2) + 1 + MAX_HISTORY_HOSTS;
  if (document.max_provider_requests !== expectedRequests
    || document.max_query_credits !== anchors.length || document.max_query_credits > MAX_ANCHORS) {
    throw new PassiveIndexError("PASSIVE_INDEX_BUDGET_INVALID", "Request or query-credit budget was invalid.");
  }
  if (typeof document.runtime_context_binding_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(document.runtime_context_binding_sha256)) {
    throw new PassiveIndexError(
      "PASSIVE_INDEX_RUNTIME_CONTEXT_BINDING_INVALID",
      "Task runtime-context binding was missing or invalid.",
    );
  }
  const createdAt = parseTimestamp(document.created_at, "created_at");
  const expiresAt = parseTimestamp(document.expires_at, "expires_at");
  const current = now();
  if (createdAt > current + 5 * 60_000
    || (!allowExpired && expiresAt <= current)
    || expiresAt - createdAt > 7 * 24 * 60 * 60_000) {
    throw new PassiveIndexError("PASSIVE_INDEX_EXPIRED", "Task authorization window was invalid or expired.");
  }
  if (!allowExpired && expiresAt - current < MIN_EXECUTION_HEADROOM_MS) {
    throw new PassiveIndexError(
      "PASSIVE_INDEX_EXECUTION_WINDOW_INSUFFICIENT",
      "Task did not retain enough attested-context lifetime for bounded execution.",
    );
  }
  assertExactKeys(document.authorization, new Set([
    "basis", "approved_by", "approved_at", "scope", "active_scanning",
    "public_targeting_output", "private_normalized_observations",
  ]), "PASSIVE_INDEX_AUTHORIZATION_INVALID");
  if (document.authorization.basis !== "PUBLIC_AUTHORITATIVE_ENTITY_ANCHORS"
    || document.authorization.approved_by !== "owner"
    || document.authorization.scope !== "passive_private_index_enrichment"
    || document.authorization.active_scanning !== false
    || document.authorization.public_targeting_output !== false
    || document.authorization.private_normalized_observations !== true) {
    throw new PassiveIndexError("PASSIVE_INDEX_AUTHORIZATION_INVALID", "Task authorization did not satisfy the passive private contract.");
  }
  const approvedAt = parseTimestamp(document.authorization.approved_at, "authorization.approved_at");
  if (approvedAt > current + 5 * 60_000 || approvedAt > createdAt + 5 * 60_000) {
    throw new PassiveIndexError("PASSIVE_INDEX_AUTHORIZATION_INVALID", "Authorization timestamp was invalid.");
  }
  return { ...document, anchors };
}

export function validatePassiveHistoryTask(document, filename, { now = Date.now } = {}) {
  assertExactKeys(document, new Set([
    "schema_version", "task_id", "project_id", "capability", "mode", "provider", "purpose",
    "source_task_id", "collection", "max_provider_requests", "max_query_credits", "created_at",
    "expires_at", "authorization",
  ]), "PASSIVE_HISTORY_SCHEMA_INVALID");
  if (document.schema_version !== 3) throw new PassiveIndexError("PASSIVE_HISTORY_SCHEMA_INVALID", "Unsupported history recovery schema.");
  if (typeof document.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,80}$/.test(document.task_id)) {
    throw new PassiveIndexError("PASSIVE_HISTORY_TASK_ID_INVALID", "History recovery task identifier was invalid.");
  }
  if (filename !== `${document.task_id}.json`) throw new PassiveIndexError("PASSIVE_HISTORY_TASK_ID_MISMATCH", "History recovery filename did not match its identifier.");
  if (document.project_id !== "KYIV") throw new PassiveIndexError("PASSIVE_HISTORY_PROJECT_ID_INVALID", "This pilot is isolated to the KYIV project.");
  if (document.capability !== HISTORY_CAPABILITY
    || document.mode !== "passive_private_history_recovery"
    || document.provider !== "shodan"
    || document.purpose !== HISTORY_PURPOSE) {
    throw new PassiveIndexError("PASSIVE_HISTORY_CAPABILITY_INVALID", "Task was outside the bounded history recovery capability.");
  }
  if (typeof document.source_task_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,80}$/.test(document.source_task_id)
    || document.source_task_id === document.task_id) {
    throw new PassiveIndexError("PASSIVE_HISTORY_SOURCE_INVALID", "Source task identifier was invalid.");
  }
  assertExactKeys(document.collection, new Set(["max_history_hosts", "raw_banner_persisted"]), "PASSIVE_HISTORY_COLLECTION_INVALID");
  if (document.collection.max_history_hosts !== MAX_HISTORY_HOSTS
    || document.collection.raw_banner_persisted !== false) {
    throw new PassiveIndexError("PASSIVE_HISTORY_COLLECTION_INVALID", "History collection bounds were invalid.");
  }
  if (document.max_provider_requests !== MAX_HISTORY_HOSTS || document.max_query_credits !== 0) {
    throw new PassiveIndexError("PASSIVE_HISTORY_BUDGET_INVALID", "History recovery must use at most two host lookups and zero query credits.");
  }
  const createdAt = parseTimestamp(document.created_at, "created_at");
  const expiresAt = parseTimestamp(document.expires_at, "expires_at");
  const current = now();
  if (createdAt > current + 5 * 60_000 || expiresAt <= current || expiresAt - createdAt > 24 * 60 * 60_000) {
    throw new PassiveIndexError("PASSIVE_HISTORY_EXPIRED", "History recovery authorization window was invalid or expired.");
  }
  assertExactKeys(document.authorization, new Set([
    "basis", "approved_by", "approved_at", "scope", "active_scanning",
    "public_targeting_output", "private_normalized_observations",
  ]), "PASSIVE_HISTORY_AUTHORIZATION_INVALID");
  if (document.authorization.basis !== "OWNER_AUTHORIZED_EXISTING_PRIVATE_RECEIPT"
    || document.authorization.approved_by !== "owner"
    || document.authorization.scope !== "passive_private_history_recovery"
    || document.authorization.active_scanning !== false
    || document.authorization.public_targeting_output !== false
    || document.authorization.private_normalized_observations !== true) {
    throw new PassiveIndexError("PASSIVE_HISTORY_AUTHORIZATION_INVALID", "History recovery authorization was invalid.");
  }
  const approvedAt = parseTimestamp(document.authorization.approved_at, "authorization.approved_at");
  if (approvedAt > current + 5 * 60_000 || approvedAt > createdAt + 5 * 60_000) {
    throw new PassiveIndexError("PASSIVE_HISTORY_AUTHORIZATION_INVALID", "History recovery approval timestamp was invalid.");
  }
  return document;
}

function queryForAnchor(anchor) { return `hostname:"${anchor.value}"`; }

function baseAnchorResult(anchor, query) {
  return {
    anchor_id: anchor.anchor_id,
    entity_id: anchor.entity_id,
    source_publisher: anchor.source.publisher,
    source_ref_sha256: sha256(anchor.source.url),
    query_sha256: sha256(query),
  };
}

function providerUrl(pathname, apiKey, params = {}) {
  const url = new URL(pathname, SHODAN_ORIGIN);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function requestOptions() {
  return { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) };
}

function countHttpError(status) {
  if (status === 429) return "SHODAN_COUNT_RATE_LIMITED";
  if ([500, 502, 503, 504].includes(status)) return "SHODAN_COUNT_TRANSIENT_HTTP";
  if ([401, 403].includes(status)) return "SHODAN_AUTH_OR_ENTITLEMENT";
  return "SHODAN_COUNT_REQUEST_REJECTED";
}

async function collectCount(anchor, { apiKey, fetchImpl }) {
  const query = queryForAnchor(anchor);
  const base = baseAnchorResult(anchor, query);
  let response;
  try { response = await fetchImpl(providerUrl("/shodan/host/count", apiKey, { query }), requestOptions()); }
  catch { return { ...base, status: "UNKNOWN", error_code: "SHODAN_COUNT_NETWORK_ERROR", total: null }; }
  if (!response.ok) return { ...base, status: "UNKNOWN", error_code: countHttpError(response.status), total: null };
  try {
    const { document, rawBytes } = await readBoundedJsonResponse(response, { provider: "shodan_count", maxBytes: MAX_COUNT_BYTES });
    if (!Number.isSafeInteger(document?.total) || document.total < 0) {
      return { ...base, status: "UNKNOWN", error_code: "SHODAN_COUNT_SCHEMA_MISMATCH", total: null, response_sha256: sha256(rawBytes) };
    }
    return { ...base, status: "COMPLETE", error_code: null, total: document.total, response_sha256: sha256(rawBytes) };
  } catch {
    return { ...base, status: "UNKNOWN", error_code: "SHODAN_COUNT_RESPONSE_INVALID", total: null };
  }
}

async function readApiInfo({ apiKey, fetchImpl }) {
  let response;
  try { response = await fetchImpl(providerUrl("/api-info", apiKey), requestOptions()); }
  catch { return { status: "UNKNOWN", error_code: "SHODAN_API_INFO_NETWORK_ERROR", query_credits: null }; }
  if (!response.ok) {
    return { status: "UNKNOWN", error_code: [401, 403].includes(response.status) ? "SHODAN_AUTH_OR_ENTITLEMENT" : "SHODAN_API_INFO_UNAVAILABLE", query_credits: null };
  }
  try {
    const { document } = await readBoundedJsonResponse(response, { provider: "shodan_api_info", maxBytes: MAX_COUNT_BYTES });
    if (!Number.isSafeInteger(document?.query_credits) || document.query_credits < 0) {
      return { status: "UNKNOWN", error_code: "SHODAN_API_INFO_SCHEMA_MISMATCH", query_credits: null };
    }
    return { status: "COMPLETE", error_code: null, query_credits: document.query_credits };
  } catch {
    return { status: "UNKNOWN", error_code: "SHODAN_API_INFO_RESPONSE_INVALID", query_credits: null };
  }
}

function dotted(record, name) {
  if (record && Object.hasOwn(record, name)) return record[name];
  let value = record;
  for (const part of name.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = value[part];
  }
  return value;
}

function safeProviderToken(value, maxLength = 96) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n<>\u0000-\u001f]/.test(normalized)
    || /\b(ignore|instructions?|system\s+prompt|assistant|jailbreak|prompt\s+injection)\b/i.test(normalized)
    || !/^[A-Za-z0-9][A-Za-z0-9 ._+:/()@=-]*$/.test(normalized)) return null;
  return normalized;
}

function safeFingerprint(value) {
  const candidate = typeof value === "object" && value !== null ? (value.sha256 ?? value.SHA256 ?? value.md5 ?? value.MD5) : value;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  return /^[A-Za-z0-9:+/=_-]{8,256}$/.test(normalized) ? normalized : null;
}

function safeInteger(value) { return Number.isSafeInteger(value) ? value : null; }

function normalizeCpes(record) {
  const values = [dotted(record, "cpe"), dotted(record, "cpe23")].flatMap((value) => Array.isArray(value) ? value : [value]);
  return [...new Set(values.map((value) => safeProviderToken(value, 180)).filter(Boolean))].slice(0, 20).sort();
}

function normalizeVulnerabilities(value) {
  const entries = [];
  if (Array.isArray(value)) {
    for (const cve of value) entries.push([cve, null]);
  } else if (typeof value === "object" && value !== null) {
    for (const [cve, metadata] of Object.entries(value)) {
      entries.push([cve, typeof metadata?.verified === "boolean" ? metadata.verified : null]);
    }
  }
  return entries.filter(([cve]) => typeof cve === "string" && /^CVE-\d{4}-\d{4,}$/.test(cve))
    .sort(([left], [right]) => left.localeCompare(right)).slice(0, 50)
    .map(([cve, verified]) => ({ cve, verified }));
}

function freshness(timestamp, nowMs) {
  if (typeof timestamp !== "string") return { observed_at: null, freshness: "UNKNOWN", age_days: null };
  const observedMs = Date.parse(timestamp);
  if (!Number.isFinite(observedMs) || observedMs > nowMs + 24 * 60 * 60_000) return { observed_at: null, freshness: "UNKNOWN", age_days: null };
  const ageDays = Math.floor((nowMs - observedMs) / (24 * 60 * 60_000));
  return { observed_at: new Date(observedMs).toISOString(), freshness: ageDays <= 30 ? "FRESH" : (ageDays <= 90 ? "AGED" : "STALE"), age_days: ageDays };
}

function exactHostnameMatch(record, anchor) {
  const hostnames = dotted(record, "hostnames");
  return Array.isArray(hostnames)
    && hostnames.some((hostname) => typeof hostname === "string" && hostname.trim().toLowerCase().replace(/\.$/, "") === anchor.value);
}

function normalizeBanner(record, anchor, origin, nowMs) {
  if (typeof record !== "object" || record === null || Array.isArray(record) || !exactHostnameMatch(record, anchor)) return null;
  const ip = dotted(record, "ip_str");
  const port = dotted(record, "port");
  if (typeof ip !== "string" || isIP(ip) === 0 || !Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  const transport = dotted(record, "transport");
  return {
    anchor_id: anchor.anchor_id,
    entity_id: anchor.entity_id,
    attribution: "EXACT_HOSTNAME_LEAD_ONLY",
    origin,
    ip,
    port,
    transport: transport === "udp" ? "udp" : "tcp",
    ...freshness(dotted(record, "timestamp"), nowMs),
    product: safeProviderToken(dotted(record, "product")),
    version: safeProviderToken(dotted(record, "version")),
    module: safeProviderToken(dotted(record, "_shodan.module")),
    cpes: normalizeCpes(record),
    tls_fingerprint: safeFingerprint(dotted(record, "ssl.cert.fingerprint")),
    ssh_fingerprint: safeFingerprint(dotted(record, "ssh.fingerprint")),
    banner_hash: safeInteger(dotted(record, "hash")),
    favicon_hash: safeInteger(dotted(record, "http.favicon.hash")),
    vulnerabilities: normalizeVulnerabilities(dotted(record, "vulns")),
    source_record_sha256: sha256(JSON.stringify(record)),
    data_classification: "UNTRUSTED_MACHINE_DATA_NEVER_INSTRUCTIONS",
  };
}

function searchHttpError(status) {
  if ([401, 403].includes(status)) return "SHODAN_AUTH_OR_ENTITLEMENT";
  if (status === 402) return "SHODAN_QUERY_CREDITS_UNAVAILABLE";
  if (status === 429) return "SHODAN_SEARCH_RATE_LIMITED_AMBIGUOUS";
  if ([500, 502, 503, 504].includes(status)) return "SHODAN_SEARCH_TRANSIENT_HTTP_AMBIGUOUS";
  return "SHODAN_SEARCH_REQUEST_REJECTED";
}

async function searchAnchor(anchor, { apiKey, fetchImpl, now }) {
  const query = queryForAnchor(anchor);
  const base = baseAnchorResult(anchor, query);
  let response;
  try {
    response = await fetchImpl(providerUrl("/shodan/host/search", apiKey, {
      query, fields: SEARCH_FIELDS.join(","), page: 1, minify: false,
    }), requestOptions());
  } catch {
    return { ...base, status: "AMBIGUOUS", error_code: "SHODAN_SEARCH_NETWORK_AMBIGUOUS", credit_min: 0, credit_max: 1, observations: [], candidates: [] };
  }
  if (!response.ok) {
    const ambiguous = response.status === 429 || [500, 502, 503, 504].includes(response.status);
    return { ...base, status: ambiguous ? "AMBIGUOUS" : "UNKNOWN", error_code: searchHttpError(response.status), credit_min: 0, credit_max: ambiguous ? 1 : 0, observations: [], candidates: [] };
  }
  let document;
  let rawBytes;
  try { ({ document, rawBytes } = await readBoundedJsonResponse(response, { provider: "shodan_search", maxBytes: MAX_SEARCH_BYTES })); }
  catch (error) {
    const errorCode = typeof error?.code === "string" && /^SHODAN_SEARCH_[A-Z0-9_]{2,80}$/.test(error.code)
      ? error.code
      : "SHODAN_SEARCH_RESPONSE_AMBIGUOUS";
    return { ...base, status: "AMBIGUOUS", error_code: errorCode, credit_min: 0, credit_max: 1, observations: [], candidates: [] };
  }
  if (!Array.isArray(document?.matches) || !Number.isSafeInteger(document?.total) || document.total < 0) {
    return { ...base, status: "AMBIGUOUS", error_code: "SHODAN_SEARCH_SCHEMA_AMBIGUOUS", credit_min: 0, credit_max: 1, observations: [], candidates: [], response_sha256: sha256(rawBytes) };
  }
  const observations = [];
  let droppedOutOfScope = 0;
  let droppedInvalid = 0;
  for (const match of document.matches.slice(0, PAGE_SIZE)) {
    if (!exactHostnameMatch(match, anchor)) { droppedOutOfScope += 1; continue; }
    const normalized = normalizeBanner(match, anchor, "SEARCH_CURRENT", now());
    if (normalized) observations.push(normalized); else droppedInvalid += 1;
  }
  return {
    ...base,
    status: "COMPLETE",
    error_code: null,
    provider_total: document.total,
    accepted_observations: observations.length,
    dropped_out_of_exact_scope: droppedOutOfScope,
    dropped_invalid: droppedInvalid,
    result_semantics: document.total === 0 ? "NO_INDEXED_MATCH_NOT_NO_EXPOSURE" : "PASSIVE_LEADS_REQUIRE_CORROBORATION",
    response_sha256: sha256(rawBytes),
    credit_min: 1,
    credit_max: 1,
    observations,
    candidates: [...new Set(observations.map((entry) => entry.ip))].map((ip) => ({ ip, anchor })),
  };
}

async function collectHistory({ ip, anchor }, { apiKey, fetchImpl, now }) {
  let response;
  try {
    response = await fetchImpl(providerUrl(`/shodan/host/${encodeURIComponent(ip)}`, apiKey, {
      history: true,
      minify: true,
    }), requestOptions());
  }
  catch { return { status: "UNKNOWN", error_code: "SHODAN_HISTORY_NETWORK_ERROR", observations: [] }; }
  if (response.status === 404) return { status: "COMPLETE", error_code: null, observations: [], semantics: "NO_INDEXED_HISTORY" };
  if (!response.ok) return { status: "UNKNOWN", error_code: "SHODAN_HISTORY_UNAVAILABLE", observations: [] };
  try {
    const { document, rawBytes } = await readBoundedJsonResponse(response, { provider: "shodan_history", maxBytes: MAX_HISTORY_BYTES });
    if (!Array.isArray(document?.data)) return { status: "UNKNOWN", error_code: "SHODAN_HISTORY_SCHEMA_MISMATCH", observations: [] };
    const hostnames = Array.isArray(document.hostnames) ? document.hostnames : [];
    const observations = document.data.slice(0, MAX_HISTORY_RECORDS_PER_HOST).map((record) => normalizeBanner({
      ...record,
      ip_str: record?.ip_str ?? document.ip_str ?? ip,
      hostnames: Array.isArray(record?.hostnames) ? record.hostnames : hostnames,
    }, anchor, "SHODAN_HOST_HISTORY", now())).filter(Boolean);
    return { status: "COMPLETE", error_code: null, response_sha256: sha256(rawBytes), observations };
  } catch (error) {
    const errorCode = typeof error?.code === "string" && /^SHODAN_HISTORY_[A-Z0-9_]{2,80}$/.test(error.code)
      ? error.code
      : "SHODAN_HISTORY_RESPONSE_INVALID";
    return { status: "UNKNOWN", error_code: errorCode, observations: [] };
  }
}

function publicSearchSummary(search) {
  const { observations, candidates, ...summary } = search;
  return summary;
}

function deduplicateObservations(observations) {
  const seen = new Set();
  return observations.filter((entry) => {
    const key = [entry.anchor_id, entry.ip, entry.port, entry.transport, entry.observed_at, entry.origin, entry.source_record_sha256].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateHistorySource(task, sourceTask, sourceReceipt, {
  sourceTaskSha256,
  sourceReceiptSha256,
} = {}) {
  if (sourceTask?.task_id !== task.source_task_id
    || sourceTask?.project_id !== task.project_id
    || sourceTask?.capability !== CAPABILITY) {
    throw new PassiveIndexError("PASSIVE_HISTORY_SOURCE_TASK_INVALID", "History recovery source task was invalid.");
  }
  if (typeof sourceTaskSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceTaskSha256)
    || typeof sourceReceiptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceReceiptSha256)
    || sourceReceipt?.private_only !== true
    || sourceReceipt?.capability !== CAPABILITY
    || sourceReceipt?.task_id !== sourceTask.task_id
    || sourceReceipt?.project_id !== task.project_id
    || sourceReceipt?.request_sha256 !== sourceTaskSha256
    || !["COMPLETE", "PARTIAL"].includes(sourceReceipt?.status)
    || sourceReceipt?.result?.capability !== CAPABILITY
    || sourceReceipt?.result?.project_id !== task.project_id
    || sourceReceipt?.result?.task_id !== sourceTask.task_id
    || !Array.isArray(sourceReceipt?.result?.observations)) {
    throw new PassiveIndexError("PASSIVE_HISTORY_SOURCE_RECEIPT_INVALID", "History recovery source receipt was invalid.");
  }
  const anchorsById = new Map(sourceTask.anchors.map((anchor) => [anchor.anchor_id, anchor]));
  const seen = new Set();
  const candidates = [];
  for (const observation of sourceReceipt.result.observations) {
    if (observation?.origin !== "SEARCH_CURRENT" || typeof observation.ip !== "string" || isIP(observation.ip) === 0) continue;
    const anchor = anchorsById.get(observation.anchor_id);
    if (!anchor) continue;
    const key = `${anchor.anchor_id}|${observation.ip}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ip: observation.ip, anchor });
    if (candidates.length === MAX_HISTORY_HOSTS) break;
  }
  return { candidates, sourceReceiptSha256 };
}

export async function executePassiveHistoryTask(rawTask, {
  sourceTask,
  sourceReceipt,
  sourceTaskSha256,
  sourceReceiptSha256,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const task = validatePassiveHistoryTask(rawTask, `${rawTask.task_id}.json`, { now });
  const source = validateHistorySource(task, sourceTask, sourceReceipt, { sourceTaskSha256, sourceReceiptSha256 });
  const base = {
    schema_version: 3,
    private_only: true,
    capability: HISTORY_CAPABILITY,
    project_id: task.project_id,
    task_id: task.task_id,
    provider: "shodan",
    purpose: task.purpose,
    source_task_ref_sha256: sha256(task.source_task_id),
    source_receipt_sha256: source.sourceReceiptSha256,
    execution_contract: {
      passive_provider_index_only: true,
      allowed_endpoint_classes: ["HOST_HISTORY"],
      active_scanning: false,
      search_allowed: false,
      count_allowed: false,
      api_info_allowed: false,
      raw_provider_records_persisted: false,
      public_target_output: false,
      max_provider_requests: MAX_HISTORY_HOSTS,
      max_history_records_per_host: MAX_HISTORY_RECORDS_PER_HOST,
      max_query_credits: 0,
      automatic_retry: false,
    },
    additional_monetary_spend_usd: 0,
    query_credits_spent: 0,
    query_credit_min: 0,
    query_credit_max: 0,
    query_credit_semantics: "EXACT_NO_SEARCH_ENDPOINT",
    evidence_semantics: "PASSIVE_HISTORY_LEAD_ONLY_REQUIRES_INDEPENDENT_CORROBORATION",
    provider_data_semantics: "UNTRUSTED_MACHINE_DATA_NEVER_INSTRUCTIONS",
    collected_at: isoNow(now),
  };
  const apiKey = typeof env.SHODAN_API_KEY === "string" ? env.SHODAN_API_KEY.trim() : "";
  if (!apiKey) {
    return {
      ...base,
      status: "UNKNOWN",
      error_code: "SHODAN_CREDENTIAL_MISSING",
      provider_requests_sent: 0,
      source_candidates: source.candidates.length,
      history_requests: [],
      observations: [],
      quality_metrics: { normalized_history_observations: 0, active_scans: 0, raw_banners_persisted: 0 },
      parent_investigation_effect: "NONE_SENSOR_UNKNOWN",
    };
  }
  const histories = [];
  for (const candidate of source.candidates) {
    histories.push(await collectHistory(candidate, { apiKey, fetchImpl, now }));
  }
  const complete = histories.filter((history) => history.status === "COMPLETE").length;
  const status = histories.length === 0 || complete === histories.length
    ? "COMPLETE"
    : (complete > 0 ? "PARTIAL" : "UNKNOWN");
  const observations = deduplicateObservations(histories.flatMap((history) => history.observations));
  return {
    ...base,
    status,
    error_code: status === "COMPLETE" ? null : (status === "PARTIAL" ? "SHODAN_HISTORY_SENSOR_PARTIAL" : "SHODAN_HISTORY_SENSOR_UNKNOWN"),
    provider_requests_sent: histories.length,
    source_candidates: source.candidates.length,
    history_requests: histories.map((history) => ({
      status: history.status,
      error_code: history.error_code,
      observation_count: history.observations.length,
      response_sha256: history.response_sha256 ?? null,
    })),
    observations,
    quality_metrics: {
      normalized_history_observations: observations.length,
      verified_cve_leads: observations.flatMap((entry) => entry.vulnerabilities).filter((entry) => entry.verified === true).length,
      unverified_cve_leads: observations.flatMap((entry) => entry.vulnerabilities).filter((entry) => entry.verified !== true).length,
      stale_observations: observations.filter((entry) => entry.freshness === "STALE").length,
      active_scans: 0,
      raw_banners_persisted: 0,
    },
    parent_investigation_effect: status === "COMPLETE" ? "NONE_UNTIL_INDEPENDENT_CORROBORATION" : `NONE_SENSOR_${status}`,
  };
}

export async function executePassiveIndexTask(rawTask, { env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const task = validatePassiveIndexTask(rawTask, `${rawTask.task_id}.json`, { now });
  const apiKey = typeof env.SHODAN_API_KEY === "string" ? env.SHODAN_API_KEY.trim() : "";
  const base = {
    schema_version: 2,
    private_only: true,
    capability: CAPABILITY,
    project_id: task.project_id,
    task_id: task.task_id,
    purpose: task.purpose,
    provider: "shodan",
    execution_contract: {
      passive_provider_index_only: true,
      allowed_endpoint_classes: ["COUNT", "API_INFO", "SEARCH", "HOST_HISTORY"],
      active_scanning: false,
      arbitrary_query_allowed: false,
      raw_provider_records_persisted: false,
      public_target_output: false,
      page_size: PAGE_SIZE,
      max_pages_per_anchor: 1,
      max_query_credits: task.max_query_credits,
      ambiguous_paid_request_auto_retry: false,
    },
    additional_monetary_spend_usd: 0,
    evidence_semantics: "PASSIVE_LEAD_ONLY_REQUIRES_INDEPENDENT_CORROBORATION",
    provider_data_semantics: "UNTRUSTED_MACHINE_DATA_NEVER_INSTRUCTIONS",
    collected_at: isoNow(now),
  };
  if (!apiKey) {
    return { ...base, status: "UNKNOWN", error_code: "SHODAN_CREDENTIAL_MISSING", provider_requests_sent: 0, query_credits_spent: 0, query_credit_min: 0, query_credit_max: 0, anchors: [], observations: [], parent_investigation_effect: "NONE_SENSOR_UNKNOWN" };
  }

  let providerRequests = 0;
  const counts = [];
  for (const anchor of task.anchors) {
    counts.push(await collectCount(anchor, { apiKey, fetchImpl }));
    providerRequests += 1;
  }
  const positiveAnchors = task.anchors.filter((anchor) => counts.find((entry) => entry.anchor_id === anchor.anchor_id)?.total > 0);
  if (positiveAnchors.length === 0) {
    const known = counts.filter((entry) => entry.status === "COMPLETE").length;
    const status = known === counts.length ? "COMPLETE" : (known > 0 ? "PARTIAL" : "UNKNOWN");
    return {
      ...base,
      status,
      error_code: status === "UNKNOWN" ? "SHODAN_COUNT_UNAVAILABLE" : null,
      provider_requests_sent: providerRequests,
      query_credits_spent: 0,
      query_credit_min: 0,
      query_credit_max: 0,
      anchors: counts.map((count) => ({ ...count, search: { status: "SKIPPED_NO_INDEXED_MATCH" } })),
      observations: [],
      parent_investigation_effect: status === "COMPLETE" ? "NONE_NO_INDEXED_MATCH" : `NONE_SENSOR_${status}`,
    };
  }

  const apiInfo = await readApiInfo({ apiKey, fetchImpl });
  providerRequests += 1;
  if (apiInfo.status !== "COMPLETE" || apiInfo.query_credits < positiveAnchors.length) {
    return {
      ...base,
      status: "PARTIAL",
      error_code: apiInfo.status === "COMPLETE" ? "SHODAN_QUERY_BUDGET_UNAVAILABLE" : apiInfo.error_code,
      provider_requests_sent: providerRequests,
      query_credits_spent: 0,
      query_credit_min: 0,
      query_credit_max: 0,
      anchors: counts.map((count) => ({ ...count, search: { status: "SKIPPED_CREDIT_GATE" } })),
      observations: [],
      parent_investigation_effect: "NONE_SENSOR_PARTIAL",
    };
  }

  const searches = [];
  for (const anchor of positiveAnchors) {
    searches.push(await searchAnchor(anchor, { apiKey, fetchImpl, now }));
    providerRequests += 1;
  }
  const candidates = searches.flatMap((search) => search.candidates).slice(0, MAX_HISTORY_HOSTS);
  const histories = [];
  for (const candidate of candidates) {
    histories.push(await collectHistory(candidate, { apiKey, fetchImpl, now }));
    providerRequests += 1;
  }
  const creditMin = searches.reduce((sum, search) => sum + search.credit_min, 0);
  const creditMax = searches.reduce((sum, search) => sum + search.credit_max, 0);
  const observations = deduplicateObservations([...searches.flatMap((search) => search.observations), ...histories.flatMap((history) => history.observations)]);
  const status = searches.some((search) => search.status !== "COMPLETE")
    || histories.some((history) => history.status !== "COMPLETE")
    || counts.some((count) => count.status !== "COMPLETE") ? "PARTIAL" : "COMPLETE";
  const searchByAnchor = new Map(searches.map((search) => [search.anchor_id, publicSearchSummary(search)]));
  return {
    ...base,
    status,
    error_code: status === "PARTIAL" ? "SHODAN_SENSOR_PARTIAL" : null,
    provider_requests_sent: providerRequests,
    query_credits_spent: creditMin === creditMax ? creditMin : null,
    query_credit_min: creditMin,
    query_credit_max: creditMax,
    query_credit_semantics: creditMin === creditMax ? "EXACT" : "AMBIGUOUS_NO_AUTO_RETRY",
    anchors: counts.map((count) => ({ ...count, search: searchByAnchor.get(count.anchor_id) ?? { status: count.total === 0 ? "SKIPPED_NO_INDEXED_MATCH" : "SKIPPED_COUNT_UNKNOWN" } })),
    history_requests: histories.map((history) => ({ status: history.status, error_code: history.error_code, observation_count: history.observations.length })),
    observations,
    quality_metrics: {
      normalized_observations: observations.length,
      verified_cve_leads: observations.flatMap((entry) => entry.vulnerabilities).filter((entry) => entry.verified === true).length,
      unverified_cve_leads: observations.flatMap((entry) => entry.vulnerabilities).filter((entry) => entry.verified !== true).length,
      stale_observations: observations.filter((entry) => entry.freshness === "STALE").length,
      dropped_out_of_exact_scope: searches.reduce((sum, search) => sum + (search.dropped_out_of_exact_scope ?? 0), 0),
      active_scans: 0,
      raw_banners_persisted: 0,
    },
    parent_investigation_effect: status === "COMPLETE" ? "NONE_UNTIL_INDEPENDENT_CORROBORATION" : "NONE_SENSOR_PARTIAL",
  };
}
