import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadCatalog, resolveLaunch, searchCatalog, validateCatalog } from "../lib/catalog.js";

const catalog = validateCatalog(JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8")));

test("search ranks a matching zero-cost utility", () => {
  const results = searchCatalog(catalog, "github repository");
  assert.equal(results[0].id, "github.repo_ops");
});

test("metered utility is excluded from search", () => {
  const results = searchCatalog(catalog, "paid example");
  assert.equal(results.some((item) => item.id === "metered.example"), false);
});

test("zero-cost gate blocks metered launch", () => {
  assert.deepEqual(resolveLaunch(catalog, "metered.example"), {
    ok: false,
    reason: "zero_cost_gate",
    id: "metered.example",
    cost: { class: "metered", max_usd_per_run: 0.01 },
  });
});

test("zero-cost gate permits included plugin utility", () => {
  const result = resolveLaunch(catalog, "github.repo_ops");
  assert.equal(result.ok, true);
  assert.equal(result.launch.target, "GitHub");
});

test("server can boot from the bundled public catalog without secrets", () => {
  const bundled = loadCatalog({});
  assert.ok(bundled.utilities.length >= 4);
  assert.equal(searchCatalog(bundled, "openai plugin")[0].id, "openai.developers");
});
