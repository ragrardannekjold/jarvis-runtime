import test from "node:test";
import assert from "node:assert/strict";
import { createExposureEngine } from "../src/engine.mjs";
import { tempWorkspace } from "./helpers.mjs";

test("dry-run is default and never calls fetch", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const engine = createExposureEngine({
    baseDir,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network must not be reached");
    },
  });
  const result = await engine.collect({ asset: "example.com", allowlistPath });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.networkRequests, 0);
  assert.deepEqual(result.providerOrder, ["shodan", "censys", "netlas"]);
  assert.equal(result.plans[0].query, 'hostname:"example.com"');
  assert.equal(result.plans[1].query, 'host.dns.names: "example.com"');
  assert.equal(result.plans[2].query, "host:example.com");
  assert.equal(calls, 0);
});

test("non-boolean execute values cannot bypass the dry-run gate", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  let calls = 0;
  const engine = createExposureEngine({
    baseDir,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network must not be reached");
    },
  });
  await assert.rejects(
    engine.collect({ asset: "example.com", allowlistPath, execute: "false" }),
    { code: "INVALID_EXECUTE" },
  );
  assert.equal(calls, 0);
});

test("CIDR plans cannot widen beyond the exact authorized CIDR", async () => {
  const { baseDir, allowlistPath } = await tempWorkspace();
  const result = await createExposureEngine({ baseDir }).collect({ asset: "192.0.2.0/24", allowlistPath });
  assert.equal(result.plans[0].query, 'net:"192.0.2.0/24"');
  assert.equal(result.plans[1].query, 'host.ip: "192.0.2.0/24"');
  assert.equal(result.plans[2].query, 'ip:"192.0.2.0/24"');
});
