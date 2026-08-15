import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PUBLIC_CATALOG } from "../lib/public-catalog.js";

const schema = JSON.parse(
  readFileSync(new URL("../schemas/utility-catalog.schema.json", import.meta.url), "utf8"),
);

function assertKeysCovered(value, propertySchema, label) {
  const allowed = new Set(Object.keys(propertySchema?.properties ?? {}));
  for (const key of Object.keys(value ?? {})) {
    assert.equal(allowed.has(key), true, `${label}: schema is missing property ${key}`);
  }
}

test("public catalog fields remain represented in the published JSON schema", () => {
  assertKeysCovered(PUBLIC_CATALOG, schema, "catalog");
  const utilitySchema = schema.$defs.utility;
  for (const utility of PUBLIC_CATALOG.utilities) {
    assertKeysCovered(utility, utilitySchema, utility.id);
    assertKeysCovered(utility.launch, utilitySchema.properties.launch, `${utility.id}.launch`);
    assertKeysCovered(utility.cost, utilitySchema.properties.cost, `${utility.id}.cost`);
    assertKeysCovered(utility.risk, utilitySchema.properties.risk, `${utility.id}.risk`);
    assertKeysCovered(utility.status, utilitySchema.properties.status, `${utility.id}.status`);
    if (utility.deployment) {
      assertKeysCovered(utility.deployment, schema.$defs.deployment, `${utility.id}.deployment`);
    }
    if (utility.resilience) {
      assertKeysCovered(utility.resilience, schema.$defs.resilience, `${utility.id}.resilience`);
      for (const reserve of utility.resilience.internal_reserves ?? []) {
        assertKeysCovered(reserve, schema.$defs.internalReserve, `${utility.id}.internal_reserve`);
      }
    }
  }
});

test("schema preserves fail-closed lifecycle and resilience states", () => {
  const utilityProperties = schema.$defs.utility.properties;
  assert.ok(utilityProperties.fallback_ids);
  assert.ok(utilityProperties.failure_domain);
  assert.ok(utilityProperties.failure_scope);
  assert.ok(utilityProperties.resilience);
  assert.ok(utilityProperties.deployment);
  assert.equal(utilityProperties.status.properties.health.enum.includes("not_deployed"), true);

  const required = new Set(schema.$defs.resilience.required);
  for (const field of [
    "min_external_failure_domains",
    "min_internal_reserves",
    "freshness_required",
    "freshness_max_seconds",
    "readback_required",
    "internal_reserves",
  ]) {
    assert.equal(required.has(field), true, `resilience schema must require ${field}`);
  }
});
