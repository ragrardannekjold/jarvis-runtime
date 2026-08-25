import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDomain,
  normalizeEntityName,
  normalizeTaxId,
  resolveEntities,
} from "./entity-resolver.mjs";

test("normalizes common legal-form noise without erasing the entity", () => {
  assert.equal(normalizeEntityName('ООО «Пример Телеком»'), "пример телеком");
  assert.equal(normalizeEntityName("Example Networks LLC"), "example networks");
  assert.equal(normalizeTaxId("77-0123-4567"), "7701234567");
  assert.equal(normalizeDomain("WWW.Example.NET."), "example.net");
});

test("clusters aliases by strong tax identifier", () => {
  const clusters = resolveEntities([
    {
      name: 'ООО «Пример Телеком»',
      jurisdiction: "RU",
      tax_id: "7701234567",
      source_ref: "source:A",
    },
    {
      name: "Пример-Телеком",
      jurisdiction: "RU",
      tax_id: "77 0123 4567",
      domain: "example.net",
      source_ref: "source:B",
    },
    {
      name: "Other Networks LLC",
      jurisdiction: "RU",
      tax_id: "7707654321",
      source_ref: "source:C",
    },
  ]);

  assert.equal(clusters.length, 2);
  const merged = clusters.find((cluster) => cluster.member_count === 2);
  assert.ok(merged);
  assert.deepEqual(merged.source_refs, ["source:A", "source:B"]);
  assert.ok(merged.match_keys.includes("tax:RU:7701234567"));
  assert.ok(merged.match_keys.includes("domain:example.net"));
});

test("does not merge same normalized name across jurisdictions", () => {
  const clusters = resolveEntities([
    { name: "Example Networks LLC", jurisdiction: "US", source_ref: "source:US" },
    { name: "Example Networks Ltd", jurisdiction: "GB", source_ref: "source:GB" },
  ]);
  assert.equal(clusters.length, 2);
});

test("domain bridge can merge records even when names differ", () => {
  const clusters = resolveEntities([
    { name: "Example Fiber", jurisdiction: "UA", domain: "network.example", source_ref: "source:1" },
    { name: "Example Infrastructure", jurisdiction: "UA", domain: "www.network.example", source_ref: "source:2" },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].member_count, 2);
  assert.ok(clusters[0].match_keys.includes("domain:network.example"));
});
