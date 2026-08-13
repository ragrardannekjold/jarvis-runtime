import { readFileSync } from "node:fs";
import { PUBLIC_CATALOG } from "./public-catalog.js";

const ALLOWED_COST_CLASSES = new Set(["free", "included"]);

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

export function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("Catalog must be a JSON object");
  }
  if (catalog.schema_version !== 1 || !Array.isArray(catalog.utilities)) {
    throw new Error("Catalog schema_version=1 and utilities[] are required");
  }

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
    if (!utility.risk || typeof utility.risk.confirmation_required !== "boolean") {
      throw new Error(`${utility.id}: risk.confirmation_required is required`);
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

export function isLaunchable(utility) {
  return Boolean(
    utility?.visibility === "plugin" &&
      utility?.status?.enabled === true &&
      utility?.status?.health !== "disabled" &&
      isZeroIncrementalCost(utility)
  );
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
  if (utility.visibility !== "plugin") return { ok: false, reason: "not_plugin_visible", id };
  if (!utility.status.enabled || utility.status.health === "disabled") {
    return { ok: false, reason: "disabled", id };
  }
  if (!isZeroIncrementalCost(utility)) {
    return { ok: false, reason: "zero_cost_gate", id, cost: utility.cost };
  }
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
