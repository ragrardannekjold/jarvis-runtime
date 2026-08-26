import assert from "node:assert/strict";
import { classifyWorkflowRuns, planIncidentActions } from "./sentinel.mjs";

const base = {
  status: "completed",
  created_at: "2026-08-26T11:30:00.000Z",
  updated_at: "2026-08-26T11:40:00.000Z",
};
const runs = [
  { ...base, id: 1, workflow_id: 1, name: "Active", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/1" },
  { ...base, id: 3, workflow_id: 2, name: "Recovered", conclusion: "success", created_at: "2026-08-26T11:50:00.000Z", updated_at: "2026-08-26T11:51:00.000Z", html_url: "https://github.com/o/r/actions/runs/3" },
  { ...base, id: 2, workflow_id: 2, name: "Recovered", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/2" },
  { ...base, id: 4, workflow_id: 3, name: "Expected", conclusion: "cancelled", html_url: "https://github.com/o/r/actions/runs/4" },
];
const states = classifyWorkflowRuns(runs, {
  now: new Date("2026-08-26T12:00:00.000Z"),
  expectedCancelledWorkflows: ["Expected"],
});
const recovered = states.find((state) => state.workflow_id === 2);
const open = [{
  issue_number: 9,
  workflow_id: 2,
  fingerprint: "gha:v1:old",
  latest_run_id: 2,
  occurrences: 1,
  first_seen_at: "2026-08-26T11:40:00.000Z",
}];
const actions = planIncidentActions(states, open);
const receipt = {
  states: Object.fromEntries(["ACTIVE_FAILURE", "RECOVERED_INCIDENT", "EXPECTED_CANCEL"]
    .map((name) => [name, states.filter((state) => state.state === name).length])),
  actions: Object.fromEntries(["CREATE", "CLOSE"]
    .map((name) => [name, actions.filter((action) => action.action === name).length])),
};
assert.equal(recovered.state, "RECOVERED_INCIDENT");
assert.deepEqual(receipt, {
  states: { ACTIVE_FAILURE: 1, RECOVERED_INCIDENT: 1, EXPECTED_CANCEL: 1 },
  actions: { CREATE: 1, CLOSE: 1 },
});
console.log(`ANOMALY_SENTINEL_CANARY ${JSON.stringify(receipt)}`);
