import { resolveLaunchWithFallback } from "./catalog.js";

export const RESTRICTED_CAPABILITY_CLASSES = Object.freeze([
  "exploitation",
  "active_third_party_scanning",
  "bypass",
  "credential_abuse",
  "payload_delivery",
  "unauthorized_access",
  "harmful_exact_tactical_detail",
]);

const PASSIVE_CYBER_SAFE_SUBSTITUTE =
  "Passive public-source OSINT/CYBINT only: RDAP/DNS/certificate-transparency/ASN/BGP/public measurements and history, public technical documentation, corporate/procurement/court/property/registry records, contractor/counterparty graphs, provenance/source genealogy, and non-actionable defensive technology/exposure inventory.";

const SAFE_ROUTE_MAP = Object.freeze({
  exploitation: {
    target_id: "chatgpt.web_search",
    safe_substitute: PASSIVE_CYBER_SAFE_SUBSTITUTE,
  },
  active_third_party_scanning: {
    target_id: "chatgpt.web_search",
    safe_substitute: PASSIVE_CYBER_SAFE_SUBSTITUTE,
  },
  bypass: {
    target_id: "chatgpt.web_search",
    safe_substitute: PASSIVE_CYBER_SAFE_SUBSTITUTE,
  },
  credential_abuse: {
    target_id: "chatgpt.web_search",
    safe_substitute: PASSIVE_CYBER_SAFE_SUBSTITUTE,
  },
  payload_delivery: {
    target_id: "chatgpt.web_search",
    safe_substitute: PASSIVE_CYBER_SAFE_SUBSTITUTE,
  },
  unauthorized_access: {
    target_id: "chatgpt.web_search",
    safe_substitute: PASSIVE_CYBER_SAFE_SUBSTITUTE,
  },
  harmful_exact_tactical_detail: {
    target_id: "chatgpt.web_search",
    safe_substitute:
      "Aggregate, non-actionable defensive analysis from public sources only; preserve provenance and uncertainty while omitting exact coordinates, tactical routes, targeting windows, or other harmful operational detail.",
  },
});

function cleanObjective(value) {
  return typeof value === "string" ? value.trim().slice(0, 1000) : "";
}

export function preparePolicyAwareLaunch(
  catalog,
  { id, objective = "", restricted_capability_class = null } = {},
) {
  const normalizedObjective = cleanObjective(objective);

  if (!restricted_capability_class) {
    return {
      ...resolveLaunchWithFallback(catalog, id),
      policy_route_rewritten: false,
      objective: normalizedObjective || undefined,
    };
  }

  const safeRoute = SAFE_ROUTE_MAP[restricted_capability_class];
  if (!safeRoute) {
    return {
      ok: false,
      id,
      requested_id: id,
      reason: "no_safe_substitute_mapping",
      policy_route_rewritten: true,
      restricted_capability_class,
      objective: normalizedObjective || undefined,
      safe_substitute: null,
      restricted_route_not_retried: true,
      attempted: [],
    };
  }

  const safeResult = resolveLaunchWithFallback(catalog, safeRoute.target_id);
  return {
    ...safeResult,
    requested_id: id,
    selected_safe_id: safeResult.id ?? safeRoute.target_id,
    policy_route_rewritten: true,
    restricted_capability_class,
    objective: normalizedObjective || undefined,
    safe_substitute: safeRoute.safe_substitute,
    restricted_route_not_retried: true,
  };
}
