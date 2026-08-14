import { readFileSync } from "node:fs";
import { PUBLIC_CATALOG } from "./public-catalog.js";

const ALLOWED_COST_CLASSES = new Set(["free", "included"]);
const ALLOWED_HEALTH = new Set(["healthy", "degraded", "not_deployed", "disabled", "unknown"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const TIMEZONE_SUFFIX_RE = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

export function normalizeText(value) {
  return String(value ?? "")
    .toLocaleLowerCase("uk-UA")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, " ")
    .trim();
}

function asTokens(value) {
  return new Set(normalizeText(value).split(/\s+/).filter(Boolean));
}

function isHttpsDeploymentUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !new Set(["github.com", "www.github.com", "raw.githubusercontent.com"]).has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function parseCatalogTimestamp(value) {
  if (typeof value !== "string" || !value.trim() || !TIMEZONE_SUFFIX_RE.test(value.trim())) {
    throw new Error("Catalog updated_at must be a timezone-aware timestamp");
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error("Catalog updated_at must be a valid timestamp");
  return timestamp;
}

export function hasVerifiedMcpDeployment(utility) {
  const deployment = utility?.deployment;
  return Boolean(
    deployment &&
      isHttpsDeploymentUrl(deployment.health_url) &&
      isHttpsDeploymentUrl(deployment.mcp_url) &&
      typeof deployment.verified_at === "string" &&
      !Number.isNaN(Date.parse(deployment.verified_at)) &&
      deployment.external_health_verified === true &&
      deployment.mcp_initialize_verified === true &&
      deployment.tool_call_verified === true &&
      typeof deployment.readback_sha256 === "string" &&
      SHA256_RE.test(deployment.readback_sha256) &&
      typeof deployment.evidence_source === "string" &&
      deployment.evidence_source.trim().length > 0
  );
}

export function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("Catalog must be a JSON object");
  }
  if (catalog.schema_version !== 1 || !Array.isArray(catalog.utilities)) {
    throw new Error("Catalog schema_version=1 and utilities[] are required");
  }
  parseCatalogTimestamp(catalog.updated_at);

  const ids = new Set();
  for (const utility of catalog.utilities) {
    for (const field of ["id", "name", "description", "url"]) {
      if (typeof utility?.[field] !== "string" || !utility[field].trim()) {
        throw new Error(`Utility is missing required string field: ${field}`);
      }
    }
    if (ids.has(utility.id)) throw new Error(`Duplicate utility id: ${utility.id}`);
    ids.add(utility.id);
    for (const field of ["aliases", "intents", "capabilities"]) {
      if (!Array.isArray(utility[field])) throw new Error(`${utility.id}: ${field} must be an array`);
    }
    if (!utility.launch?.kind || !utility.launch?.target) {
      throw new Error(`${utility.id}: launch.kind and launch.target are required`);
    }
    if (!utility.cost || typeof utility.cost.max_usd_per_run !== "number") {
      throw new Error(`${utility.id}: cost.max_usd_per_run is required`);
    }
    if (!utility.status || typeof utility.status.enabled !== "boolean") {
      throw new Error(`${utility.id}: status.enabled is required`);
    }
    if (typeof utility.status.health !== "string" || !ALLOWED_HEALTH.has(utility.status.health)) {
      throw new Error(`${utility.id}: status.health is invalid`);
    }
    if (utility.status.health === "healthy" && utility.status.enabled !== true) {
      throw new Error(`${utility.id}: a disabled utility cannot claim healthy`);
    }
    if (!utility.risk || typeof utility.risk.confirmation_required !== "boolean") {
      throw new Error(`${utility.id}: risk.confirmation_required is required`);
    }
    if (utility.launch.kind === "mcp_tool") {
      if (utility.status.enabled === true && utility.status.health === "healthy" && !hasVerifiedMcpDeployment(utility)) {
        throw new Error(`${utility.id}: READY MCP claim requires verified external deployment readback`);
      }
      if (utility.status.health === "not_deployed" && utility.status.enabled !== false) {
        throw new Error(`${utility.id}: not_deployed MCP utility must be disabled`);
      }
    }
  }
  return catalog;
}

export function loadCatalog(env = process.env) {
  if (env.UTILITY_CATALOG_JSON) {
    return validateCatalog(JSON.parse(env.UTILITY_CATALOG_JSON));
  }
  if (env.UTILITY_CATALOG_PATH) {
    return validateCatalog(JSON.parse(readFileSync(env.UTILITY_CATALOG_PATH, "utf8")));
  }
  return validateCatalog(structuredClone(PUBLIC_CATALOG));
}

export function isZeroIncrementalCost(utility) {
  return ALLOWED_COST_CLASSES.has(utility?.cost?.class) && utility?.cost?.max_usd_per_run === 0;
}

export function launchReadiness(utility) {
  if (utility?.visibility !== "plugin") return { ok: false, reason: "not_plugin_visible" };
  if (utility?.status?.enabled !== true) return { ok: false, reason: "disabled" };
  if (utility?.status?.health !== "healthy") {
    return { ok: false, reason: "unhealthy", health: utility?.status?.health ?? "unknown" };
  }
  if (utility?.launch?.kind === "mcp_tool" && !hasVerifiedMcpDeployment(utility)) {
    return { ok: false, reason: "deployment_unverified" };
  }
  if (!isZeroIncrementalCost(utility)) {
    return { ok: false, reason: "zero_cost_gate", cost: utility?.cost };
  }
  return { ok: true };
}

export function isLaunchable(utility) {
  return launchReadiness(utility).ok;
}

export function catalogDiagnostics(catalog, now = new Date()) {
  const updatedAtMs = parseCatalogTimestamp(catalog?.updated_at);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new Error("Diagnostics now must be a valid timestamp");
  const ageSeconds = Math.max(0, Math.floor((nowDate.getTime() - updatedAtMs) / 1000));
  const utilities = Array.isArray(catalog?.utilities) ? catalog.utilities : [];
  return {
    catalog_updated_at: catalog.updated_at,
    catalog_age_seconds: ageSeconds,
    utility_count: utilities.length,
    launchable_utility_count: utilities.filter(isLaunchable).length,
    zero_incremental_cost_utility_count: utilities.filter(isZeroIncrementalCost).length,
    degraded_utility_count: utilities.filter((utility) => utility?.status?.health === "degraded").length,
    not_deployed_utility_count: utilities.filter((utility) => utility?.status?.health === "not_deployed").length,
  };
}

function scoreField(query, queryTokens, value, weight) {
  const normalized = normalizeText(value);
  if (!normalized) return 0;
  if (normalized === query) return weight * 1.4;
  if (normalized.includes(query)) return weight;
  const tokens = asTokens(normalized);
  let overlap = 0;
  for (const token of queryTokens) if (tokens.has(token)) overlap += 1;
  return queryTokens.size ? weight * (overlap / queryTokens.size) : 0;
}

function structuredInterfaceBonus(utility) {
  if (!isLaunchable(utility)) return 0;
  if (utility?.launch?.kind === "mcp_tool") return 12;
  if (utility?.launch?.kind === "chat_plugin") return 8;
  if (utility?.launch?.kind === "chat_capability") return 4;
  return 0;
}

export function scoreUtility(utility, rawQuery) {
  const query = normalizeText(rawQuery);
  const queryTokens = asTokens(query);
  let score = 0;
  score += scoreField(query, queryTokens, utility.id, 40);
  score += scoreField(query, queryTokens, utility.name, 36);
  for (const alias of utility.aliases ?? []) score += scoreField(query, queryTokens, alias, 20);
  for (const intent of utility.intents ?? []) score += scoreField(query, queryTokens, intent, 18);
  for (const capability of utility.capabilities ?? []) score += scoreField(query, queryTokens, capability, 14);
  score += scoreField(query, queryTokens, utility.description, 10);
  score += Number(utility.priority ?? 50) / 20;
  if (utility.status?.health === "healthy") score += 4;
  score += structuredInterfaceBonus(utility);
  if (!isLaunchable(utility)) score -= 1000;
  return score;
}

export function searchCatalog(catalog, query, limit = 8) {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  return catalog.utilities
    .map((utility) => ({ utility, score: scoreUtility(utility, normalized) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.utility.name.localeCompare(b.utility.name))
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map(({ utility, score }) => ({ ...utility, _score: Math.round(score * 100) / 100 }));
}

export function getUtility(catalog, id) {
  return catalog.utilities.find((utility) => utility.id === id) ?? null;
}

export function resolveLaunch(catalog, id) {
  const utility = getUtility(catalog, id);
  if (!utility) return { ok: false, reason: "not_found", id };
  const readiness = launchReadiness(utility);
  if (!readiness.ok) return { ok: false, id, ...readiness };
  return {
    ok: true,
    id: utility.id,
    name: utility.name,
    launch: utility.launch,
    risk: utility.risk,
    cost: utility.cost,
    url: utility.url,
  };
}
