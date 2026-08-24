import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL("../../.github/workflows/private-async-bridge.yml", import.meta.url);

function topLevelTriggers(workflow) {
  const lines = workflow.split(/\r?\n/);
  const onKeys = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^(?:on|"on"|'on')\s*:/.test(lines[index])) onKeys.push(index);
  }
  assert.equal(onKeys.length, 1);
  const start = onKeys[0];
  assert.match(lines[start], /^(?:on|"on"|'on')\s*:\s*$/);
  const triggers = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^[ \t]/.test(line) && !/^\s*#/.test(line)) break;
    const match = line.match(/^[ \t]{2}([^:#]+)\s*:/);
    if (match) triggers.push(match[1].trim().replace(/^["']|["']$/g, ""));
  }
  return triggers;
}

test("legacy V1 bridge workflow is an inert manual stub", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.deepEqual(topLevelTriggers(workflow), ["workflow_dispatch"]);
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
