import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  authorizeAsset,
  canonicalizeCidr,
  canonicalizeDomain,
  ipInCidr,
  parseAsset,
} from "../src/assets.mjs";
import { tempWorkspace } from "./helpers.mjs";

test("canonicalizes IPv4, IPv6, and IDN assets deterministically", () => {
  assert.equal(canonicalizeCidr("192.0.2.123/24"), "192.0.2.0/24");
  assert.equal(canonicalizeCidr("2001:db8::1/64"), "2001:db8::/64");
  assert.equal(canonicalizeDomain("EXAMPLE.com."), "example.com");
  assert.equal(canonicalizeDomain("münich.example"), "xn--mnich-kva.example");
});

test("checks IPv4 and IPv6 membership without widening CIDR scope", () => {
  assert.equal(ipInCidr("192.0.2.25", "192.0.2.0/24"), true);
  assert.equal(ipInCidr("198.51.100.25", "192.0.2.0/24"), false);
  assert.equal(ipInCidr("2001:db8::25", "2001:db8::/64"), true);
  assert.equal(ipInCidr("2001:db9::25", "2001:db8::/64"), false);
});

test("rejects bare IPs, wildcards, URLs, and invalid CIDRs", () => {
  assert.throws(() => parseAsset("192.0.2.1"), { code: "CIDR_REQUIRED" });
  assert.throws(() => parseAsset("*.example.com"), { code: "INVALID_DOMAIN" });
  assert.throws(() => parseAsset("https://example.com"), { code: "INVALID_DOMAIN" });
  assert.throws(() => parseAsset("192.0.2.0/33"), { code: "INVALID_CIDR" });
});

test("requires an exact owned/authorized allowlist entry", async () => {
  const { allowlistPath } = await tempWorkspace();
  assert.deepEqual(await authorizeAsset("example.com", allowlistPath), { type: "domain", value: "example.com" });
  await assert.rejects(authorizeAsset("unlisted.example.com", allowlistPath), { code: "ASSET_NOT_AUTHORIZED" });
});

test("rejects allowlists without the explicit authorization assertion", async () => {
  const { baseDir } = await tempWorkspace();
  const file = path.join(baseDir, "unsafe.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, assets: [{ type: "domain", value: "example.com" }] }));
  await assert.rejects(authorizeAsset("example.com", file), { code: "AUTHORIZATION_ASSERTION_REQUIRED" });
});
