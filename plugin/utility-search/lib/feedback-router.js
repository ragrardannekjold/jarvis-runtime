import { getUtility } from "./catalog.js";
import { prepareContextAwareLaunch } from "./context-router.js";

function normalizeFailedFailureDomains(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("failed_failure_domains must be an array");
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("failed_failure_domains must contain non-empty strings");
    }
    const domain = item.trim().toLowerCase();
    if (seen.has(domain)) continue;
    seen.add(domain);
    normalized.push(domain);
  }
  return normalized;
}

function orderedFallbackIds(catalog, rootId) {
  const ordered = [];
  const visited = new Set();
  function visit(candidateId) {
    if (visited.has(candidateId)) return;
    visited.add(candidateId);
    if (candidateId !== rootId) ordered.push(candidateId);
    const candidate = getUtility(catalog, candidateId);
    for (const fallbackId of candidate?.fallback_ids ?? []) visit(fallbackId);
  }
  visit(rootId);
  return ordered;
}

function selectedFailureDomain(catalog, result) {
  const declared = result?.launch?.failure_domain;
  if (typeof declared === "string" && declared.trim()) return declared.trim().toLowerCase();
  const utility = getUtility(catalog, result?.id);
  return typeof utility?.failure_domain === "string" ? utility.failure_domain.trim().toLowerCase() : null;
}

function filterReadbackCandidates(result, failedSet) {
  const candidates = result?.launch?.pre_execution_readback?.on_failure?.candidates;
  if (!Array.isArray(candidates)) return result;
  return {
    ...result,
    launch: {
      ...result.launch,
      pre_execution_readback: {
        ...result.launch.pre_execution_readback,
        on_failure: {
          ...result.launch.pre_execution_readback.on_failure,
          candidates: candidates.filter((candidate) => {
            const domain = typeof candidate?.failure_domain === "string"
              ? candidate.failure_domain.trim().toLowerCase()
              : null;
            return !domain || !failedSet.has(domain);
          }),
        },
      },
    },
  };
}

function withFeedbackMetadata(result, failedDomains, feedbackRerouteUsed, feedbackAttempted) {
  return {
    ...result,
    failed_failure_domains: failedDomains,
    feedback_reroute_used: feedbackRerouteUsed,
    feedback_attempted: feedbackAttempted,
  };
}

function candidateSequence(catalog, requestedId, initialResult) {
  const ordered = [];
  const seen = new Set();
  for (const candidateId of [initialResult?.id, ...orderedFallbackIds(catalog, requestedId)]) {
    if (typeof candidateId !== "string" || seen.has(candidateId)) continue;
    seen.add(candidateId);
    ordered.push(candidateId);
  }
  return ordered;
}

export function prepareLaunchWithFeedback(
  catalog,
  {
    id,
    objective = "",
    restricted_capability_class = null,
    execution_context = null,
    failed_failure_domains = [],
  } = {},
) {
  const normalizedFailedDomains = normalizeFailedFailureDomains(failed_failure_domains);
  const failedSet = new Set(normalizedFailedDomains);
  const baseOptions = { id, objective, restricted_capability_class, execution_context };
  const initial = prepareContextAwareLaunch(catalog, baseOptions);
  const feedbackAttempted = [];

  if (!initial.ok || failedSet.size === 0) {
    return withFeedbackMetadata(
      filterReadbackCandidates(initial, failedSet),
      normalizedFailedDomains,
      false,
      feedbackAttempted,
    );
  }

  const initialDomain = selectedFailureDomain(catalog, initial);
  if (!initialDomain || !failedSet.has(initialDomain)) {
    return withFeedbackMetadata(
      filterReadbackCandidates(initial, failedSet),
      normalizedFailedDomains,
      false,
      feedbackAttempted,
    );
  }

  feedbackAttempted.push({
    id: initial.id,
    failure_domain: initialDomain,
    ok: false,
    reason: "failure_domain_previously_failed",
  });

  // A policy rewrite must never retry the restricted route. Any failover starts from
  // the already-selected safe substitute and only follows its explicitly configured fallbacks.
  const routeRootId = initial.policy_route_rewritten ? initial.id : id;
  const candidates = candidateSequence(catalog, routeRootId, initial);
  const seenSelectedIds = new Set([initial.id]);

  for (const candidateId of candidates) {
    const utility = getUtility(catalog, candidateId);
    const candidateDomain = typeof utility?.failure_domain === "string"
      ? utility.failure_domain.trim().toLowerCase()
      : null;
    if (candidateDomain && failedSet.has(candidateDomain)) {
      if (candidateId !== initial.id) {
        feedbackAttempted.push({
          id: candidateId,
          failure_domain: candidateDomain,
          ok: false,
          reason: "failure_domain_previously_failed",
        });
      }
      continue;
    }

    const candidateResult = prepareContextAwareLaunch(catalog, {
      id: candidateId,
      objective: initial.policy_route_rewritten ? "" : objective,
      restricted_capability_class: null,
      execution_context,
    });
    if (!candidateResult.ok) {
      feedbackAttempted.push({
        id: candidateId,
        failure_domain: candidateDomain,
        ok: false,
        reason: candidateResult.reason,
      });
      continue;
    }

    if (seenSelectedIds.has(candidateResult.id)) continue;
    seenSelectedIds.add(candidateResult.id);
    const selectedDomain = selectedFailureDomain(catalog, candidateResult);
    if (selectedDomain && failedSet.has(selectedDomain)) {
      feedbackAttempted.push({
        id: candidateResult.id,
        failure_domain: selectedDomain,
        ok: false,
        reason: "failure_domain_previously_failed",
      });
      continue;
    }

    feedbackAttempted.push({
      id: candidateResult.id,
      failure_domain: selectedDomain,
      ok: true,
    });

    const policyMetadata = initial.policy_route_rewritten
      ? {
          policy_route_rewritten: true,
          policy_risk_inferred: initial.policy_risk_inferred,
          restricted_capability_class: initial.restricted_capability_class,
          objective: initial.objective,
          safe_substitute: initial.safe_substitute,
          restricted_route_not_retried: true,
          selected_safe_id: candidateResult.id,
        }
      : {};

    return withFeedbackMetadata(
      filterReadbackCandidates(
        {
          ...candidateResult,
          ...policyMetadata,
          requested_id: id,
          fallback_used: candidateResult.id !== id,
          primary_reason: "failure_domain_previously_failed",
        },
        failedSet,
      ),
      normalizedFailedDomains,
      true,
      feedbackAttempted,
    );
  }

  return withFeedbackMetadata(
    {
      ok: false,
      id: initial.id ?? id,
      requested_id: id,
      reason: initial.policy_route_rewritten
        ? "safe_substitute_failure_domains_exhausted"
        : "failure_domains_exhausted",
      fallback_used: false,
      primary_reason: "failure_domain_previously_failed",
      policy_route_rewritten: initial.policy_route_rewritten ?? false,
      policy_risk_inferred: initial.policy_risk_inferred ?? false,
      restricted_capability_class: initial.restricted_capability_class,
      objective: initial.objective,
      safe_substitute: initial.safe_substitute,
      restricted_route_not_retried: initial.policy_route_rewritten ? true : undefined,
      execution_context: initial.execution_context,
      context_state: initial.context_state,
      data_access_started: false,
    },
    normalizedFailedDomains,
    true,
    feedbackAttempted,
  );
}
