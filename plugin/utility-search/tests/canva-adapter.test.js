import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog, resolveLaunch, searchCatalog } from "../lib/catalog.js";
import { prepareContextAwareLaunch } from "../lib/context-router.js";

test("bundled catalog routes existing Canva design lookup to read-only search-designs", () => {
  const catalog = loadCatalog({});
  const results = searchCatalog(catalog, "canva existing design search");
  assert.equal(results[0].id, "canva.design_search");

  const launch = resolveLaunch(catalog, "canva.design_search");
  assert.equal(launch.ok, true);
  assert.equal(launch.launch.target, "Canva");
  assert.equal(launch.launch.tool, "search-designs");
  assert.equal(launch.risk.mode, "read_only");
  assert.equal(launch.risk.confirmation_required, false);
});

test("Canva design search is compatible with verified noninteractive routing", () => {
  const catalog = loadCatalog({});
  const launch = prepareContextAwareLaunch(catalog, {
    id: "canva.design_search",
    execution_context: "noninteractive",
  });
  assert.equal(launch.ok, true);
  assert.equal(launch.id, "canva.design_search");
  assert.equal(launch.context_state, "COMPATIBLE_NONINTERACTIVE");
  assert.equal(launch.data_access_started, false);
});
