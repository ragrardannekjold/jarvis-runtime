import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL("../../.github/workflows/private-async-bridge.yml", import.meta.url);

test("legacy V1 bridge workflow is an inert manual stub", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  const topLevelOnKeys = workflow.match(/^on:\s*$/gm) ?? [];
  assert.equal(topLevelOnKeys.length, 1);
  assert.doesNotMatch(workflow, /^on:[ \t]+\S/m);
  assert.match(workflow, /^on:\s*\n  workflow_dispatch:\s*\n\npermissions:\s*\{\}/m);
  assert.match(workflow, /if:\s*\$\{\{ false \}\}/);
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.doesNotMatch(workflow, /issues:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /COMMAND_CENTER_TOKEN/);
  assert.doesNotMatch(workflow, /SHODAN_API_KEY/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, /runtime\/private-async\/worker\.mjs/);
});
