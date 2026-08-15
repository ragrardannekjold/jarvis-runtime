import { getUtility, resolveLaunch } from "./catalog.js";
import {
  inferRestrictedCapabilityClass,
  preparePolicyAwareLaunch,
} from "./policy-router.js";

export const EXECUTION_CONTEXTS = Object.freeze(["interactive", "noninteractive"]);
export const CONTEXT_STATES = Object.freeze([
  "COMPATIBLE_NONINTERACTIVE",
  "INTERACTIVE_ONLY_FOR_CONTEXT",
  "UNKNOWN_CONTEXT",
  "GLOBAL_UNAVAILABLE",
]);

const ALLOWED_CONTEXT_STATES = new Set(CONTEXT_STATES);
const VERIFIED_NONINTERACTIVE_IDS = new Set([
  "github.repo_ops",
  "airtable.record_search",
  "vercel.project_ops",
  "google_drive.search",
  "gmail.message_search",
  "chatgpt.web_search",
]);

function normalizeExecutionContext(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!EXECUTION_CONTEXTS.includes(value)) {
    throw new Error(`Unsupported execution context: ${value}`);
  }
  return value;
}

export function contextStateForUtility(utility, executionContext) {
  const context = normalizeExecutionContext(executionContext);
  if (!context) return null;

  const declared = utility?.execution_context?.[context];
  if (declared !== undefined) {
    if (typeof declared !== "string" || !ALLOWED_CONTEXT_STATES.has(declared)) {
      throw new Error(`${utility?.id ?? "utility"}: invalid ${context} execution-context state`);
    }
    return declared;
  }

  if (context === "noninteractive" && VERIFIED_NONINTERACTIVE_IDS.has(utility?.id)) {
    return "COMPATIBLE_NONINTERACTIVE";
  }
  return "UNKNOWN_CONTEXT";
}

function contextReason(state) {
  if (state === "INTERACTIVE_ONLY_FOR_CONTEXT") return "interactive_only_for_context";
  if (state === "GLOBAL_UNAVAILABLE") return "global_unavailable";
  if (state === "UNKNOWN_CONTEXT") return "unknown_context";
  return null;
}

export function resolveLaunchWithContext(catalog, id, executionContext) {
  const context = normalizeExecutionContext(executionContext);
  if (!context) return null;

  const attempted = [];
  const visited = new Set();
  let primaryFailure = null;

  function tryId(candidateId) {
    if (visited.has(candidateId)) return null;
    visited.add(candidateId);

    const utility = getUtility(catalog, candidateId);
    if (!utility) {
      const failure = { ok: false, id: candidateId, reason: "not_found" };
      attempted.push({ id: candidateId, ok: false, reason: failure.reason });
      if (candidateId === id) primaryFailure = failure;
      return null;
    }

    const launch = resolveLaunch(catalog, candidateId);
    if (!launch.ok) {
      attempted.push({ id: candidateId, ok: false, reason: launch.reason });
      if (candidateId === id) primaryFailure = launch;
    } else {
      const contextState = contextStateForUtility(utility, context);
      const reason = context === "noninteractive" && contextState !== "COMPATIBLE_NONINTERACTIVE"
        ? contextReason(contextState)
        : null;
      if (!reason) {
        attempted.push({ id: candidateId, ok: true });
        return {
          ...launch,
          execution_context: context,
          context_state: contextState,
          data_access_started: false,
        };
      }
      const failure = {
        ok: false,
        id: candidateId,
        reason,
        execution_context: context,
        context_state: contextState,
        data_access_started: false,
      };
      attempted.push({ id: candidateId, ok: false, reason, context_state: contextState });
      if (candidateId === id) primaryFailure = failure;
    }

    for (const fallbackId of utility.fallback_ids ?? []) {
      const fallback = tryId(fallbackId);
      if (fallback?.ok) return fallback;
    }
    return null;
  }

  const selected = tryId(id);
  if (selected?.ok) {
    return {
      ...selected,
      requested_id: id,
      fallback_used: selected.id !== id,
      primary_reason: selected.id !== id ? primaryFailure?.reason ?? null : null,
      context_reroute_used: selected.id !== id && attempted.some((item) => item.reason === "interactive_only_for_context" || item.reason === "unknown_context"),
      attempted,
    };
  }

  return {
    ...(primaryFailure ?? {
      ok: false,
      id,
      reason: "unavailable",
      execution_context: context,
      context_state: "UNKNOWN_CONTEXT",
      data_access_started: false,
    }),
    requested_id: id,
    fallback_used: false,
    context_reroute_used: false,
    attempted,
  };
}

export function prepareContextAwareLaunch(
  catalog,
  { id, objective = "", restricted_capability_class = null, execution_context = null } = {},
) {
  const context = normalizeExecutionContext(execution_context);
  if (!context) {
    return preparePolicyAwareLaunch(catalog, { id, objective, restricted_capability_class });
  }

  const effectiveRestrictedClass = restricted_capability_class ?? inferRestrictedCapabilityClass(objective, id);
  if (effectiveRestrictedClass) {
    const policyResult = preparePolicyAwareLaunch(catalog, {
      id,
      objective,
      restricted_capability_class,
    });
    if (!policyResult.ok) return { ...policyResult, execution_context: context, data_access_started: false };

    const selectedUtility = getUtility(catalog, policyResult.id);
    const contextState = contextStateForUtility(selectedUtility, context);
    if (context === "noninteractive" && contextState !== "COMPATIBLE_NONINTERACTIVE") {
      return {
        ...policyResult,
        ok: false,
        reason: contextReason(contextState),
        execution_context: context,
        context_state: contextState,
        data_access_started: false,
      };
    }
    return {
      ...policyResult,
      execution_context: context,
      context_state: contextState,
      data_access_started: false,
    };
  }

  return {
    ...resolveLaunchWithContext(catalog, id, context),
    policy_route_rewritten: false,
    policy_risk_inferred: false,
    objective: typeof objective === "string" && objective.trim() ? objective.trim().slice(0, 1000) : undefined,
  };
}
