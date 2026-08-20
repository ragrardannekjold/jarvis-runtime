import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, stat, unlink } from "node:fs/promises";
import { createExposureEngine } from "../src/engine.mjs";
import { appendEvidenceBatch, verifyEvidence } from "../src/evidence.mjs";
import { buildCensysPlan } from "../src/queries.mjs";
import { sha256 } from "../src/util.mjs";
import { censysHit, fixedNow, jsonResponse, tempWorkspace } from "./helpers.mjs";

test("Censys v3 paginates deterministically, normalizes, and checkpoints", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const requests = [];
  const token = "fake-censys-token-never-log";
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body, headers: options.headers, redirect: options.redirect });
    if (!body.page_token) {
      return jsonResponse({
        result: {
          hits: [censysHit("192.0.2.10")],
          next_page_token: "page-two",
          previous_page_token: "",
          total_hits: 2,
          query_duration_millis: 8,
        },
      });
    }
    return jsonResponse({
      result: {
        hits: [censysHit("192.0.2.11", { port: 8443 })],
        next_page_token: "",
        previous_page_token: "page-one",
        total_hits: 2,
        query_duration_millis: 5,
      },
    });
  };
  const engine = createExposureEngine({
    baseDir,
    fetchImpl,
    env: { CENSYS_PLATFORM_TOKEN: token, CENSYS_ORGANIZATION_ID: "11111111-2222-3333-4444-555555555555" },
    now: fixedNow,
  });
  const result = await engine.collect({
    asset: "192.0.2.0/24",
    allowlistPath,
    execute: true,
    provider: "censys",
    pageSize: 50,
    maxPages: 2,
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.pagesThisRun, 2);
  assert.equal(result.observationsWritten, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.page_size, 50);
  assert.equal(requests[0].body.query, 'host.ip: "192.0.2.0/24"');
  assert.equal(requests[1].body.page_token, "page-two");
  assert.equal(requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(requests[0].redirect, "error");

  const evidenceText = await readFile(result.evidencePath, "utf8");
  assert.doesNotMatch(evidenceText, new RegExp(token));
  assert.match(evidenceText, /"provider":"censys"/);
  assert.match(evidenceText, /"fingerprintSha256":"a{64}"/);
  assert.match(evidenceText, /"reverseNames":\["ptr\.example\.com"\]/);
  assert.equal((await verifyEvidence(result.evidencePath)).count, 4);

  const checkpoint = JSON.parse(await readFile(result.checkpointPath, "utf8"));
  assert.equal(checkpoint.status, "COMPLETE");
  assert.equal(checkpoint.pageIndex, 2);
  assert.equal(checkpoint.nextCursor, null);
  assert.equal((await stat(result.evidencePath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.checkpointPath)).mode & 0o777, 0o600);
  assert.equal((await stat(`${baseDir}/.state/circuits.json`)).mode & 0o777, 0o600);
  assert.equal((await stat(`${baseDir}/evidence`)).mode & 0o777, 0o700);
  assert.equal((await stat(`${baseDir}/.state`)).mode & 0o777, 0o700);
});

test("mixed provider response cannot commit an out-of-scope observation", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const result = await createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => jsonResponse({
      result: {
        hits: [censysHit("192.0.2.30"), censysHit("198.51.100.30")],
        next_page_token: "",
      },
    }),
  }).collect({ asset: "192.0.2.0/24", allowlistPath, execute: true, provider: "censys" });
  assert.equal(result.observationsWritten, 1);
  const evidence = await readFile(result.evidencePath, "utf8");
  assert.match(evidence, /192\.0\.2\.30/);
  assert.doesNotMatch(evidence, /198\.51\.100\.30/);
  assert.match(evidence, /"droppedOutOfScopeCount":1/);
  const entries = evidence.trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(entries.map((entry) => entry.kind), ["observation", "provider_page"]);
  assert.equal(typeof entries[1].payload.observationSetHash, "string");
});

test("Censys resumes from the exact saved page token", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const cursors = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    cursors.push(body.page_token ?? null);
    if (!body.page_token) {
      return jsonResponse({ result: { hits: [censysHit("192.0.2.20")], next_page_token: "resume-me" } });
    }
    return jsonResponse({ result: { hits: [censysHit("192.0.2.21")], next_page_token: "" } });
  };
  const engine = createExposureEngine({ baseDir, fetchImpl, env: { CENSYS_PLATFORM_TOKEN: "fake" }, now: fixedNow });
  const first = await engine.collect({ asset: "192.0.2.0/24", allowlistPath, execute: true, provider: "censys", maxPages: 1 });
  assert.equal(first.status, "PAUSED");
  assert.equal(first.nextCursor, "resume-me");
  const second = await engine.collect({ asset: "192.0.2.0/24", allowlistPath, execute: true, provider: "censys", maxPages: 1 });
  assert.equal(second.status, "COMPLETE");
  assert.deepEqual(cursors, [null, "resume-me"]);
  assert.equal(second.observationsWritten, 2);
});

test("completed checkpoint is idempotent and performs no new API read", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ result: { hits: [], next_page_token: "" } });
    },
  });
  await engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  const replay = await engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  assert.equal(replay.resumed, true);
  assert.equal(calls, 1);
});

test("provider page rawHash is computed from exact response bytes", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const raw = ' {\n  "result": { "hits": [], "next_page_token": "" }\n}\n';
  const result = await createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => new Response(raw, { status: 200, headers: { "content-type": "application/json" } }),
  }).collect({ asset: "192.0.2.0/24", allowlistPath, execute: true, provider: "censys" });
  const entries = (await readFile(result.evidencePath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  const page = entries.find((entry) => entry.kind === "provider_page");
  assert.equal(page.payload.rawHash, sha256(Buffer.from(raw)));
});

test("cached COMPLETE is rejected if its evidence head was deleted", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ result: { hits: [], next_page_token: "" } });
    },
  });
  const first = await engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  await unlink(first.evidencePath);
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" }),
    { code: "CHECKPOINT_EVIDENCE_MISSING" },
  );
  assert.equal(calls, 1);
});

test("checkpoint evidence head may be a verified member behind the global ledger head", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ result: { hits: [], next_page_token: "" } });
    },
  });
  const first = await engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  await appendEvidenceBatch(first.evidencePath, [{ kind: "later_independent_event", payload: { safe: true } }], { now: fixedNow });
  const replay = await engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  assert.equal(replay.status, "COMPLETE");
  assert.equal(calls, 1);
});

test("engine recovers a torn final evidence fragment before cached replay", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ result: { hits: [], next_page_token: "" } });
    },
  });
  const first = await engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  await appendFile(first.evidencePath, '{"schemaVersion":1,"seq":2');
  const replay = await engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  assert.equal(replay.status, "COMPLETE");
  assert.equal(calls, 1);
  const entries = (await readFile(first.evidencePath, "utf8")).trimEnd().split("\n").map(JSON.parse);
  assert.equal(entries.some((entry) => entry.kind === "evidence_tail_recovered"), true);
});

test("legacy page-first record without a final bound commit marker is never cached COMPLETE", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const asset = { type: "cidr", value: "192.0.2.0/24" };
  const plan = buildCensysPlan(asset, 100);
  const evidencePath = `${baseDir}/evidence/exposure.ndjson`;
  await appendEvidenceBatch(evidencePath, [{
    kind: "provider_page",
    payload: {
      provider: "censys",
      queryHash: plan.queryHash,
      asset,
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      rawHash: "f".repeat(64),
      pageCommitId: "legacy-page-first",
      pageObservationCount: 1,
      cumulativeObservationCount: 1,
    },
  }, {
    kind: "observation",
    payload: {
      provider: "censys",
      queryHash: plan.queryHash,
      asset,
      observationId: "legacy-observation",
    },
  }], { now: fixedNow });

  let calls = 0;
  const result = await createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ result: { hits: [], next_page_token: "" } });
    },
  }).collect({ asset: "192.0.2.0/24", allowlistPath, execute: true, provider: "censys" });
  assert.equal(calls, 1);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.observationsWritten, 0);
});
