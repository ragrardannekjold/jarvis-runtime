import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI smoke test is a no-network dry-run", () => {
  const result = spawnSync(process.execPath, [
    path.join(packageRoot, "bin", "exposure-intel.mjs"),
    "collect",
    "--asset", "example.com",
    "--allowlist", path.join(packageRoot, "examples", "allowlist.json"),
  ], { encoding: "utf8", env: {} });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "dry-run");
  assert.equal(output.networkRequests, 0);
});

test("CLI rejects unknown options with a stable public error", () => {
  const result = spawnSync(process.execPath, [
    path.join(packageRoot, "bin", "exposure-intel.mjs"), "collect", "--unknown", "value",
  ], { encoding: "utf8", env: {} });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stderr);
  assert.equal(output.error.code, "INVALID_CLI_ARGUMENT");
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
