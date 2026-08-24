import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL("../../.github/workflows/private-async-bridge.yml", import.meta.url);

function topLevelChildren(workflow, key) {
  const lines = workflow.split(/\r?\n/);
  const keyPattern = new RegExp(`^(?:${key}|"${key}"|'${key}')\\s*:`);
  const exactKeyPattern = new RegExp(`^(?:${key}|"${key}"|'${key}')\\s*:\\s*$`);
  const keyLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (keyPattern.test(lines[index])) keyLines.push(index);
  }
  assert.equal(keyLines.length, 1);
  const start = keyLines[0];
  assert.match(lines[start], exactKeyPattern);
  const children = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^[ \t]/.test(line) && !/^\s*#/.test(line)) break;
    const match = line.match(/^[ \t]{2}([^ \t:#][^:#]*)\s*:/);
    if (match) children.push(match[1].trim().replace(/^["']|["']$/g, ""));
  }
  return children;
}

test("legacy V1 bridge workflow is an inert manual stub", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.deepEqual(topLevelChildren(workflow, "on"), ["workflow_dispatch"]);
  assert.deepEqual(topLevelChildren(workflow, "jobs"), [
    "legacy-private-bridge-disabled",
  ]);
  assert.match(
    workflow,
    /^  legacy-private-bridge-disabled:\s*\n    if:\s*\$\{\{ false \}\}/m,
  );
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
