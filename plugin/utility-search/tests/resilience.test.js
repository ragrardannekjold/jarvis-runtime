import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog } from "../lib/catalog.js";
import { validateCriticalFallbackResilience } from "../lib/resilience.js";

function criticalUtility(catalog) {
  return catalog.utilities.find((utility) => utility.id === "jarvis.utility_search");
}

test("research-critical Utility Search has three independent external failure domains and an internal reserve", () => {
  const catalog = loadCatalog({});
  const validated = validateCriticalFallbackResilience(catalog);
  const utility = criticalUtility(validated);
  assert.equal(utility.resilience.min_external_failure_domains, 3);
  assert.equal(utility.resilience.min_internal_reserves, 1);
  assert.equal(utility.resilience.readback_required, true);
  assert.equal(utility.resilience.freshness_required, true);
});

test("same provider counts once even when represented by multiple fallback IDs", () => {
  const candidate = structuredClone(loadCatalog({}));
  const utility = criticalUtility(candidate);
  utility.fallback_ids = ["google_drive.search", "gmail.message_search", "github.repo_ops"];
  assert.throws(
    () => validateCriticalFallbackResilience(candidate),
    /2 independent external failure domains; requires >=3/,
  );
});

test("critical fallback validation fails closed when provider failure-domain metadata is missing", () => {
  const candidate = structuredClone(loadCatalog({}));
  const google = candidate.utilities.find((utility) => utility.id === "google_drive.search");
  delete google.failure_domain;
  assert.throws(
    () => validateCriticalFallbackResilience(candidate),
    /google_drive\.search: failure_domain must be a non-empty string/,
  );
});

test("critical fallback validation requires an internal reserve domain", () => {
  const candidate = structuredClone(loadCatalog({}));
  criticalUtility(candidate).resilience.internal_reserves = [];
  assert.throws(
    () => validateCriticalFallbackResilience(candidate),
    /0 independent internal reserve domains; requires >=1/,
  );
});

test("duplicate internal reserves in one failure domain count once", () => {
  const candidate = structuredClone(loadCatalog({}));
  const resilience = criticalUtility(candidate).resilience;
  resilience.min_internal_reserves = 2;
  resilience.internal_reserves = [
    { id: "bundled_public_catalog", kind: "bundled_snapshot", failure_domain: "local_runtime" },
    { id: "bundled_public_catalog_copy", kind: "bundled_snapshot", failure_domain: "local_runtime" },
  ];
  assert.throws(
    () => validateCriticalFallbackResilience(candidate),
    /1 independent internal reserve domains; requires >=2/,
  );
});
