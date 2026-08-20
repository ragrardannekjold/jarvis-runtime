import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createExposureEngine } from "../src/engine.mjs";
import { fixedNow, jsonResponse, tempWorkspace } from "./helpers.mjs";

function shodanHit() {
  return {
    ip_str: "192.0.2.41",
    port: 443,
    transport: "tcp",
    product: "nginx",
    version: "1.27",
    timestamp: "2026-08-19T10:00:00Z",
    hostnames: ["example.com"],
    domains: ["example.com"],
    _shodan: { module: "https" },
    ssl: { cert: { fingerprint: { sha256: "c".repeat(64) }, subject: { CN: "example.com" }, issuer: { CN: "Example CA" } } },
  };
}

test("Shodan is the first auto route and performs no-credit preflight before one paid search page", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const calls = [];
  const token = "fake-shodan-key-never-log";
  const result = await createExposureEngine({
    baseDir,
    env: { SHODAN_API_KEY: token },
    now: fixedNow,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push({ pathname: parsed.pathname, query: parsed.searchParams.get("query"), page: parsed.searchParams.get("page") });
      assert.equal(parsed.searchParams.get("key"), token);
      if (parsed.pathname === "/shodan/host/count") return jsonResponse({ total: 1, matches: [] });
      if (parsed.pathname === "/api-info") return jsonResponse({ query_credits: 99, scan_credits: 0 });
      return jsonResponse({ total: 1, matches: [shodanHit()] });
    },
  }).collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" });
  assert.equal(result.provider, "shodan");
  assert.deepEqual(calls, [
    { pathname: "/shodan/host/count", query: 'hostname:"example.com"', page: null },
    { pathname: "/api-info", query: null, page: null },
    { pathname: "/shodan/host/search", query: 'hostname:"example.com"', page: "1" },
  ]);
  const evidence = await readFile(result.evidencePath, "utf8");
  assert.doesNotMatch(evidence, new RegExp(token));
  assert.match(evidence, /"provider":"shodan"/);
  assert.match(evidence, /"queryCreditsSpent":1/);
});

test("zero Shodan hits consumes no query credit and skips plan-info and search", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const result = await createExposureEngine({
    baseDir,
    env: { SHODAN_API_KEY: "fake" },
    now: fixedNow,
    fetchImpl: async () => { calls += 1; return jsonResponse({ total: 0, matches: [] }); },
  }).collect({ asset: "example.com", allowlistPath, execute: true, provider: "shodan" });
  assert.equal(result.status, "COMPLETE");
  assert.equal(calls, 1);
});

test("exhausted Shodan credits fail over before a paid search is sent", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const hosts = [];
  const result = await createExposureEngine({
    baseDir,
    env: { SHODAN_API_KEY: "fake-s", CENSYS_PLATFORM_TOKEN: "fake-c" },
    now: fixedNow,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      hosts.push(parsed.hostname + parsed.pathname);
      if (parsed.pathname === "/shodan/host/count") return jsonResponse({ total: 10, matches: [] });
      if (parsed.pathname === "/api-info") return jsonResponse({ query_credits: 0 });
      if (parsed.hostname === "api.platform.censys.io") return jsonResponse({ result: { hits: [], next_page_token: "" } });
      throw new Error("paid Shodan search must not be sent");
    },
  }).collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" });
  assert.equal(result.provider, "censys");
  assert.deepEqual(hosts, [
    "api.shodan.io/shodan/host/count",
    "api.shodan.io/api-info",
    "api.platform.censys.io/v3/global/search/query",
  ]);
});

test("ambiguous Shodan search never invokes standby", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let censysCalls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { SHODAN_API_KEY: "fake-s", CENSYS_PLATFORM_TOKEN: "fake-c" },
    now: fixedNow,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/shodan/host/count") return jsonResponse({ total: 10, matches: [] });
      if (parsed.pathname === "/api-info") return jsonResponse({ query_credits: 10 });
      if (parsed.pathname === "/shodan/host/search") throw new TypeError("connection reset");
      censysCalls += 1;
      return jsonResponse({ result: { hits: [], next_page_token: "" } });
    },
  });
  await assert.rejects(engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" }), { code: "SHODAN_AMBIGUOUS_NETWORK" });
  assert.equal(censysCalls, 0);
});

test("a Shodan search 5xx is treated as ambiguous and never invokes standby", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let censysCalls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { SHODAN_API_KEY: "fake-s", CENSYS_PLATFORM_TOKEN: "fake-c" },
    now: fixedNow,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/shodan/host/count") return jsonResponse({ total: 10, matches: [] });
      if (parsed.pathname === "/api-info") return jsonResponse({ query_credits: 10 });
      if (parsed.pathname === "/shodan/host/search") return jsonResponse({ error: "upstream failed" }, 503);
      censysCalls += 1;
      return jsonResponse({ result: { hits: [], next_page_token: "" } });
    },
  });
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" }),
    { code: "SHODAN_AMBIGUOUS_SERVER_RESPONSE", ambiguous: true },
  );
  assert.equal(censysCalls, 0);
});
