import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createExposureEngine } from "../src/engine.mjs";
import { fixedNow, jsonResponse, netlasRecord, tempWorkspace } from "./helpers.mjs";

test("auto mode uses Netlas standby after a clear pre-evidence Censys failure", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const hosts = [];
  const fetchImpl = async (url) => {
    hosts.push(new URL(url).hostname);
    if (new URL(url).hostname === "api.platform.censys.io") return jsonResponse({ error: "temporary" }, 503);
    return jsonResponse({ items: [netlasRecord(5)], total: 1 });
  };
  const result = await createExposureEngine({
    baseDir,
    fetchImpl,
    env: { CENSYS_PLATFORM_TOKEN: "fake-c", NETLAS_API_KEY: "fake-n" },
    now: fixedNow,
  }).collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" });
  assert.equal(result.provider, "netlas");
  assert.deepEqual(hosts, ["api.platform.censys.io", "app.netlas.io"]);
  const evidence = await readFile(result.evidencePath, "utf8");
  assert.match(evidence, /"kind":"provider_failure"/);
  assert.match(evidence, /"errorCode":"CENSYS_TRANSIENT_HTTP"/);
});

test("missing primary credential may fail over because no request was sent", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const result = await createExposureEngine({
    baseDir,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ items: [], total: 0 });
    },
    env: { NETLAS_API_KEY: "fake-n" },
    now: fixedNow,
  }).collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" });
  assert.equal(result.provider, "netlas");
  assert.equal(calls, 1);
});

test("ambiguous Censys network state never blindly invokes standby", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let censysCalls = 0;
  let netlasCalls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake-c", NETLAS_API_KEY: "fake-n" },
    now: fixedNow,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === "api.platform.censys.io") {
        censysCalls += 1;
        throw new TypeError("connection reset");
      }
      netlasCalls += 1;
      return jsonResponse({ items: [], total: 0 });
    },
  });
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" }),
    { code: "CENSYS_AMBIGUOUS_NETWORK" },
  );
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" }),
    { code: "AMBIGUOUS_REVIEW_REQUIRED" },
  );
  assert.equal(censysCalls, 1);
  assert.equal(netlasCalls, 0);
  const evidence = await readFile(`${baseDir}/evidence/exposure.ndjson`, "utf8");
  assert.match(evidence, /"kind":"provider_ambiguous"/);
});

test("Censys 200 schema mismatch is ambiguous and never invokes standby", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let netlasCalls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake-c", NETLAS_API_KEY: "fake-n" },
    now: fixedNow,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === "api.platform.censys.io") return jsonResponse({ result: { unexpected: [] } });
      netlasCalls += 1;
      return jsonResponse({ items: [], total: 0 });
    },
  });
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" }),
    (error) => error.code === "CENSYS_SCHEMA_MISMATCH" && error.ambiguous === true && error.failoverAllowed === false,
  );
  assert.equal(netlasCalls, 0);
});

test("partial primary checkpoint blocks circuit skip into standby", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const hosts = [];
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake-c", NETLAS_API_KEY: "fake-n" },
    now: fixedNow,
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      hosts.push(host);
      if (host === "api.platform.censys.io") {
        return jsonResponse({ result: { hits: [], next_page_token: "resume-primary" } });
      }
      return jsonResponse({ items: [], total: 0 });
    },
  });
  const first = await engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys", maxPages: 1 });
  assert.equal(first.status, "PAUSED");
  await writeFile(`${baseDir}/.state/circuits.json`, JSON.stringify({
    schemaVersion: 1,
    providers: {
      censys: {
        consecutiveFailures: 2,
        openUntil: "2026-08-16T12:10:00.000Z",
        reason: "CENSYS_TRANSIENT_HTTP",
        updatedAt: "2026-08-16T12:00:00.000Z",
      },
    },
  }), { mode: 0o600 });
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" }),
    { code: "PARTIAL_PROVIDER_REVIEW_REQUIRED" },
  );
  assert.deepEqual(hosts, ["api.platform.censys.io"]);
});

test("oversized success response is ambiguous and bounded before standby", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let netlasCalls = 0;
  const body = JSON.stringify({ result: { hits: [], padding: "x".repeat(200) } });
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake-c", NETLAS_API_KEY: "fake-n" },
    now: fixedNow,
    maxResponseBytes: 64,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === "api.platform.censys.io") {
        return new Response(body, { status: 200, headers: { "content-length": String(Buffer.byteLength(body)) } });
      }
      netlasCalls += 1;
      return jsonResponse({ items: [], total: 0 });
    },
  });
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" }),
    (error) => error.code === "CENSYS_RESPONSE_TOO_LARGE" && error.ambiguous === true,
  );
  assert.equal(netlasCalls, 0);
});

test("truncated JSON success response is ambiguous and never invokes standby", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let netlasCalls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake-c", NETLAS_API_KEY: "fake-n" },
    now: fixedNow,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === "api.platform.censys.io") return new Response('{"result":{"hits":[', { status: 200 });
      netlasCalls += 1;
      return jsonResponse({ items: [], total: 0 });
    },
  });
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "auto" }),
    (error) => error.code === "CENSYS_AMBIGUOUS_RESPONSE" && error.ambiguous === true,
  );
  assert.equal(netlasCalls, 0);
});
