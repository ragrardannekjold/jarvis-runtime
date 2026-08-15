function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function validateCriticalFallbackResilience(catalog) {
  const utilities = Array.isArray(catalog?.utilities) ? catalog.utilities : [];
  const utilitiesById = new Map(utilities.map((utility) => [utility.id, utility]));

  for (const utility of utilities) {
    const resilience = utility?.resilience;
    if (resilience === undefined) continue;
    if (!resilience || typeof resilience !== "object" || Array.isArray(resilience)) {
      throw new Error(`${utility.id}: resilience must be an object`);
    }

    const minExternal = positiveInteger(
      resilience.min_external_failure_domains,
      `${utility.id}: resilience.min_external_failure_domains`,
    );
    const minInternal = positiveInteger(
      resilience.min_internal_reserves,
      `${utility.id}: resilience.min_internal_reserves`,
    );

    if (resilience.readback_required !== true) {
      throw new Error(`${utility.id}: resilience.readback_required must be true`);
    }
    if (resilience.freshness_required !== true) {
      throw new Error(`${utility.id}: resilience.freshness_required must be true`);
    }
    positiveInteger(
      resilience.freshness_max_seconds,
      `${utility.id}: resilience.freshness_max_seconds`,
    );

    const externalDomains = new Set();
    for (const fallbackId of utility.fallback_ids ?? []) {
      const fallback = utilitiesById.get(fallbackId);
      if (!fallback) continue; // ID integrity is checked by the catalog fallback-graph validator.
      const scope = requiredString(
        fallback.failure_scope ?? "external",
        `${fallback.id}: failure_scope`,
      );
      const domain = requiredString(fallback.failure_domain, `${fallback.id}: failure_domain`);
      if (scope === "external") externalDomains.add(domain);
    }

    if (externalDomains.size < minExternal) {
      throw new Error(
        `${utility.id}: critical fallback set has ${externalDomains.size} independent external failure domains; requires >=${minExternal}`,
      );
    }

    if (!Array.isArray(resilience.internal_reserves)) {
      throw new Error(`${utility.id}: resilience.internal_reserves must be an array`);
    }
    const internalIds = new Set();
    const internalDomains = new Set();
    for (const reserve of resilience.internal_reserves) {
      if (!reserve || typeof reserve !== "object" || Array.isArray(reserve)) {
        throw new Error(`${utility.id}: each internal reserve must be an object`);
      }
      const reserveId = requiredString(reserve.id, `${utility.id}: internal reserve id`);
      const domain = requiredString(
        reserve.failure_domain,
        `${utility.id}: internal reserve ${reserveId} failure_domain`,
      );
      if (internalIds.has(reserveId)) {
        throw new Error(`${utility.id}: duplicate internal reserve id: ${reserveId}`);
      }
      internalIds.add(reserveId);
      internalDomains.add(domain);
    }

    if (internalDomains.size < minInternal) {
      throw new Error(
        `${utility.id}: critical fallback set has ${internalDomains.size} independent internal reserve domains; requires >=${minInternal}`,
      );
    }
  }

  return catalog;
}
