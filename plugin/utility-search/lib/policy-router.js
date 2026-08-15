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

const INFERRED_RESTRICTED_PATTERNS = Object.freeze([
  ["exploitation", /(?:\bexploit(?:ation|ing|ed)?\b|експлуат\p{L}*|эксплуат\p{L}*)/giu],
  [
    "active_third_party_scanning",
    /(?:\b(?:nmap|masscan)\b|\bactive\s+(?:network|host|port)?\s*scann?\w*|\bport\s+scann?\w*|активн\p{L}*\s+скан\p{L}*|скан\p{L}*\s+(?:порт|мереж|хост|сервіс)\p{L}*|скан\p{L}*\s+(?:порт|сет|хост|сервис)\p{L}*)/giu,
  ],
  [
    "bypass",
    /(?:\bbypass(?:ing|ed)?\b|обхід\p{L}*\s+(?:доступ|автентиф|контрол|обмеж)\p{L}*|обход\p{L}*\s+(?:доступ|аутентиф|контрол|огранич)\p{L}*)/giu,
  ],
  [
    "credential_abuse",
    /(?:\bcredential\s+(?:stuffing|abuse)\b|\bpassword\s+spray\w*|викраден\p{L}*\s+(?:парол|обліков)\p{L}*|украден\p{L}*\s+(?:парол|учетн)\p{L}*)/giu,
  ],
  [
    "payload_delivery",
    /(?:\breverse\s+shell\b|\bweb\s*shell\b|\bpayload\s+(?:delivery|deploy\w*|execute\w*)|\bimplant\s+(?:deploy\w*|delivery))/giu,
  ],
  [
    "unauthorized_access",
    /(?:\bunauthori[sz]ed\s+access\b|несанкціонован\p{L}*\s+доступ\p{L}*|несанкционирован\p{L}*\s+доступ\p{L}*)/giu,
  ],
]);

const NEGATED_PREFIX_RE =
  /(?:\bwithout|\bno|\bnot|\bavoid(?:ing)?|\bexclude(?:d|ing)?|без|не|уника\p{L}*)\s*(?:\p{L}+\s+){0,2}$/iu;

function cleanObjective(value) {
  return typeof value === "string" ? value.trim().slice(0, 1000) : "";
}

function isNegatedMatch(text, startIndex) {
  const prefix = text.slice(Math.max(0, startIndex - 45), startIndex);
  return NEGATED_PREFIX_RE.test(prefix);
}

export function inferRestrictedCapabilityClass(objective = "", id = "") {
  const normalizedObjective = cleanObjective(objective);
  const normalizedId = typeof id === "string" ? id.trim().toLowerCase() : "";
  for (const capabilityClass of RESTRICTED_CAPABILITY_CLASSES) {
    if (normalizedId === `restricted.${capabilityClass}`) return capabilityClass;
  }
  if (!normalizedObjective) return null;
  for (const [capabilityClass, pattern] of INFERRED_RESTRICTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of normalizedObjective.matchAll(pattern)) {
      if (!isNegatedMatch(normalizedObjective, match.index ?? 0)) return capabilityClass;
    }
  }
  return null;
}

export function preparePolicyAwareLaunch(
  catalog,
  { id, objective = "", restricted_capability_class = null } = {},
) {
  const normalizedObjective = cleanObjective(objective);
  const inferredCapabilityClass = restricted_capability_class
    ? null
    : inferRestrictedCapabilityClass(normalizedObjective, id);
  const effectiveCapabilityClass = restricted_capability_class ?? inferredCapabilityClass;

  if (!effectiveCapabilityClass) {
    return {
      ...resolveLaunchWithFallback(catalog, id),
      policy_route_rewritten: false,
      policy_risk_inferred: false,
      objective: normalizedObjective || undefined,
    };
  }

  const safeRoute = SAFE_ROUTE_MAP[effectiveCapabilityClass];
  if (!safeRoute) {
    return {
      ok: false,
      id,
      requested_id: id,
      reason: "no_safe_substitute_mapping",
      policy_route_rewritten: true,
      policy_risk_inferred: Boolean(inferredCapabilityClass),
      restricted_capability_class: effectiveCapabilityClass,
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
    policy_risk_inferred: Boolean(inferredCapabilityClass),
    restricted_capability_class: effectiveCapabilityClass,
    objective: normalizedObjective || undefined,
    safe_substitute: safeRoute.safe_substitute,
    restricted_route_not_retried: true,
  };
}
