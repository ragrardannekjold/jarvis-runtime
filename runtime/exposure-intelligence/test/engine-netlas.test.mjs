import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createExposureEngine } from "../src/engine.mjs";
import { fixedNow, jsonResponse, netlasRecord, tempWorkspace } from "./helpers.mjs";

test("Netlas v1 uses deterministic 20-result offsets and normalizes observations", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const starts = [];
  const token = "fake-netlas-key-never-log";
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    starts.push(start);
    assert.equal(parsed.searchParams.get("q"), "host:example.com");
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    if (start === 0) return jsonResponse({ items: Array.from({ length: 20 }, (_, index) => netlasRecord(index + 1)), total: 21 });
    return jsonResponse({ items: [netlasRecord(21)], total: 21 });
  };
  const result = await createExposureEngine({
    baseDir,
    fetchImpl,
    env: { NETLAS_API_KEY: token },
    now: fixedNow,
  }).collect({ asset: "example.com", allowlistPath, execute: true, provider: "netlas", maxPages: 2 });
  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(starts, [0, 20]);
  assert.equal(result.observationsWritten, 21);
  const evidence = await readFile(result.evidencePath, "utf8");
  assert.doesNotMatch(evidence, new RegExp(token));
  assert.match(evidence, /"provider":"netlas"/);
  assert.match(evidence, /"transport":"tcp"/);
  assert.match(evidence, /"protocol":"https"/);
});

test("Netlas honors Retry-After by opening its provider circuit", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { NETLAS_API_KEY: "fake" },
    now: fixedNow,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: "throttled" }, 429, { "retry-after": "120" });
    },
  });
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "netlas" }),
    (error) => error.code === "NETLAS_RATE_LIMITED" && error.retryAfterMs === 120_000,
  );
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "netlas" }),
    { code: "PROVIDER_CIRCUIT_OPEN" },
  );
  assert.equal(calls, 1);
  const circuits = JSON.parse(await readFile(`${baseDir}/.state/circuits.json`, "utf8"));
  assert.equal(circuits.providers.netlas.openUntil, "2026-08-16T12:02:00.000Z");
});
