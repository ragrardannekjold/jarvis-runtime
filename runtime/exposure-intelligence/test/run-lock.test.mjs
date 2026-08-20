import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExposureEngine } from "../src/engine.mjs";
import { acquireDurableLock, runLockPath } from "../src/run-lock.mjs";
import { fixedNow, jsonResponse, tempWorkspace } from "./helpers.mjs";

test("durable lock cleans release tombstones and can be reacquired", async () => {
  const { baseDir } = await tempWorkspace();
  const lockPath = path.join(baseDir, ".state", "locks", "query.lock");
  const first = await acquireDurableLock(lockPath, { now: fixedNow, ownerToken: "same-test-owner" });
  await first.release();
  assert.deepEqual((await readdir(path.dirname(lockPath))).filter((name) => name.includes(".released-")), []);
  const second = await acquireDurableLock(lockPath, { now: fixedNow, ownerToken: "same-test-owner" });
  await second.release();
});

test("dead-owner lock is recovered without unlinking a replacement", async () => {
  const { baseDir } = await tempWorkspace();
  const asset = { type: "domain", value: "example.com" };
  const lockPath = runLockPath(baseDir, asset);
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
    schemaVersion: 1,
    ownerToken: "dead-owner",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    processStartMarker: null,
    heartbeatAt: "2026-08-16T12:00:00.000Z",
  }), { mode: 0o600 });
  const recovered = await acquireDurableLock(lockPath, { now: fixedNow });
  const names = await readdir(path.dirname(lockPath));
  assert.equal(names.some((name) => name.includes(".orphan-")), true);
  await recovered.release();
});

test("same-asset concurrent engine run is locked before a second provider request", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  let markStarted;
  let unblock;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const blockedResponse = new Promise((resolve) => { unblock = resolve; });
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => {
      calls += 1;
      markStarted();
      return blockedResponse;
    },
  });
  const first = engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  await started;
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" }),
    { code: "RUN_LOCKED" },
  );
  assert.equal(calls, 1);
  unblock(jsonResponse({ result: { hits: [], next_page_token: "" } }));
  await first;
  assert.equal(calls, 1);
});

test("different assets cannot enter provider fetch concurrently", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let markStarted;
  let unblock;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const blockedResponse = new Promise((resolve) => { unblock = resolve; });
  const engine = createExposureEngine({
    baseDir,
    env: { CENSYS_PLATFORM_TOKEN: "fake" },
    now: fixedNow,
    fetchImpl: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      markStarted();
      const response = await blockedResponse;
      inFlight -= 1;
      return response;
    },
  });
  const first = engine.collect({ asset: "example.com", allowlistPath, execute: true, provider: "censys" });
  await started;
  await assert.rejects(
    engine.collect({ asset: "app.example.com", allowlistPath, execute: true, provider: "censys" }),
    { code: "RUN_LOCKED" },
  );
  assert.equal(calls, 1);
  assert.equal(maxInFlight, 1);
  unblock(jsonResponse({ result: { hits: [], next_page_token: "" } }));
  await first;
  assert.equal(inFlight, 0);
});
