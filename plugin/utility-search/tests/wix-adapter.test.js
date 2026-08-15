import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog, resolveLaunch, searchCatalog } from "../lib/catalog.js";
import { prepareContextAwareLaunch } from "../lib/context-router.js";

test("bundled catalog routes Wix site lookup to dedicated read-only listing", () => {
  const catalog = loadCatalog({});
  const results = searchCatalog(catalog, "wix existing sites list");
  assert.equal(results[0].id, "wix.site_list");

  const launch = resolveLaunch(catalog, "wix.site_list");
  assert.equal(launch.ok, true);
  assert.equal(launch.launch.target, "Wix");
  assert.equal(launch.launch.tool, "ListWixSites");
  assert.equal(launch.risk.mode, "read_only");
  assert.equal(launch.risk.confirmation_required, false);
  assert.match(launch.launch.notes, /Do not use this adapter for site creation, publication, content mutation/i);
});

test("Wix site listing is compatible with verified noninteractive routing", () => {
  const catalog = loadCatalog({});
  const launch = prepareContextAwareLaunch(catalog, {
    id: "wix.site_list",
    execution_context: "noninteractive",
  });
  assert.equal(launch.ok, true);
  assert.equal(launch.id, "wix.site_list");
  assert.equal(launch.context_state, "COMPATIBLE_NONINTERACTIVE");
  assert.equal(launch.data_access_started, false);
});
