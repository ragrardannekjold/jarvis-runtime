import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classifyWorkflowHealth,
  parseIncidentIssue,
  planIncidentActions,
  renderIncidentBody,
  renderIncidentTitle,
} from "./sentinel.mjs";
import {
  collectSnapshot,
  createGithubRequest,
  executePlan,
  runSentinelCycle,
  selectExecutablePlan,
} from "./worker.mjs";

const REPOSITORY = "owner/repo";
const BRANCH = "main";
const COMMIT = "c".repeat(40);
const TREE = "d".repeat(40);
const BLOB = "a".repeat(40);
const PATH = ".github/workflows/example.yml";
const NAME = "Example Workflow";
const NOW = new Date("2026-08-26T12:00:00.000Z");
const BOT = { login: "github-actions[bot]", type: "Bot" };

function contract(overrides = {}) {
  return {
    workflow_path: PATH,
    workflow_name: NAME,
    workflow_blob_sha: BLOB,
    mode: "scheduled",
    enabled_since: "2026-08-26T10:00:00.000Z",
    expected_event: "schedule",
    cadence_ms: 5 * 60_000,
    freshness_ttl_ms: 15 * 60_000,
    grace_ms: 5 * 60_000,
    recovery_min_successes: 2,
    ...overrides,
  };
}

function manifestText(overrides = {}) {
  return JSON.stringify({
    schema_version: 2,
    baseline_ref: COMMIT,
    incident_closure_mode: "quarantine",
    contracts: [contract(overrides)],
  });
}

function apiRun(overrides = {}) {
  const id = overrides.id || 10;
  const createdAt = overrides.created_at || "2026-08-26T11:55:00.000Z";
  return {
    id,
    run_attempt: 1,
    workflow_id: 100,
    head_sha: COMMIT,
    head_branch: BRANCH,
    head_repository: { full_name: REPOSITORY },
    status: "completed",
    conclusion: "success",
    event: "schedule",
    created_at: createdAt,
    run_started_at: overrides.run_started_at || createdAt,
    updated_at: "2026-08-26T11:56:00.000Z",
    html_url: "https://github.com/owner/repo/actions/runs/" + id,
    ...overrides,
  };
}

function fakeGithub({
  heads = [COMMIT],
  repositoryDefaultBranches = [BRANCH],
  treeBlob = BLOB,
  runBlob = null,
  truncated = false,
  workflowState = "active",
  workflowStates = null,
  orphanedApiWorkflows = [],
  generalRuns = [],
  scheduleRuns = [],
  generalRunReads = null,
  scheduleRunReads = null,
  issues = [],
  postError = null,
  postState = "open",
  closePatchErrorAfterApply = null,
} = {}) {
  const calls = [];
  let headReads = 0;
  let repositoryReads = 0;
  let workflowReads = 0;
  let generalReads = 0;
  let scheduleReads = 0;
  const issueStore = new Map(issues.map((issue) => [issue.number, structuredClone(issue)]));
  let nextIssue = 1000;
  async function request(path, { method = "GET", body } = {}) {
    calls.push({ path, method, body });
    if (path === "/repos/owner/repo") {
      const defaultBranch = repositoryDefaultBranches[Math.min(repositoryReads, repositoryDefaultBranches.length - 1)];
      repositoryReads += 1;
      return { default_branch: defaultBranch };
    }
    if (path.includes("/git/ref/heads/")) {
      const sha = heads[Math.min(headReads, heads.length - 1)];
      headReads += 1;
      return { object: { sha } };
    }
    if (path === "/repos/owner/repo/git/commits/" + COMMIT) return { sha: COMMIT, tree: { sha: TREE } };
    if (path === "/repos/owner/repo/git/trees/" + TREE + "?recursive=1") {
      return { truncated, tree: [{ path: PATH, type: "blob", sha: treeBlob }] };
    }
    if (path.startsWith("/repos/owner/repo/actions/workflows?")) {
      const workflows = [{
        id: 100,
        name: NAME,
        path: PATH,
        html_url: "https://github.com/owner/repo/actions/workflows/example.yml",
        state: workflowState,
      }, ...orphanedApiWorkflows];
      return {
        total_count: workflows.length,
        workflows,
      };
    }
    if (path === "/repos/owner/repo/actions/workflows/100") {
      const states = workflowStates || [workflowState];
      const state = states[Math.min(workflowReads, states.length - 1)];
      workflowReads += 1;
      return {
        id: 100,
        name: NAME,
        path: PATH,
        html_url: "https://github.com/owner/repo/actions/workflows/example.yml",
        state,
      };
    }
    if (path.startsWith("/repos/owner/repo/contents/.github/workflows/example.yml?ref=")) {
      return { type: "file", path: PATH, sha: runBlob || treeBlob };
    }
    if (path.includes("/actions/workflows/100/runs?")) {
      if (path.includes("event=schedule")) {
        const reads = scheduleRunReads || [scheduleRuns];
        const runs = reads[Math.min(scheduleReads, reads.length - 1)];
        scheduleReads += 1;
        return { total_count: runs.length, workflow_runs: runs };
      }
      const reads = generalRunReads || [generalRuns];
      const runs = reads[Math.min(generalReads, reads.length - 1)];
      generalReads += 1;
      return { total_count: runs.length, workflow_runs: runs };
    }
    if (path.startsWith("/repos/owner/repo/issues?")) return [...issueStore.values()].filter((issue) => issue.state !== "closed");
    const issueMatch = path.match(/^\/repos\/owner\/repo\/issues\/(\d+)$/);
    if (path === "/repos/owner/repo/issues" && method === "POST") {
      if (postError) throw postError;
      const issue = { number: nextIssue, state: postState, user: BOT, title: body.title, body: body.body };
      nextIssue += 1;
      issueStore.set(issue.number, issue);
      return structuredClone(issue);
    }
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      const current = issueStore.get(number);
      if (!current) throw new Error("missing_fake_issue");
      if (method === "PATCH") {
        const next = { ...current, ...body };
        issueStore.set(number, next);
        if (body.state === "closed" && closePatchErrorAfterApply) throw closePatchErrorAfterApply;
        return structuredClone(next);
      }
      return structuredClone(current);
    }
    throw new Error("unexpected_fake_path:" + method + ":" + path);
  }
  return { request, calls, issueStore };
}

function classify({ now = NOW, all = [], scheduled = [] } = {}) {
  return classifyWorkflowHealth({
    repository: REPOSITORY,
    now,
    workflowInventory: [{
      workflow_id: 100,
      workflow_name: NAME,
      workflow_path: PATH,
      workflow_url: "https://github.com/owner/repo/actions/workflows/example.yml",
      workflow_blob_sha_at_run: BLOB,
      workflow_state: "active",
      workflow_blob_sha: BLOB,
    }],
    livenessContracts: [contract()],
    allEventRuns: all.map((item) => ({
      ...item,
      workflow_name: NAME,
      workflow_path: PATH,
      workflow_url: "https://github.com/owner/repo/actions/workflows/example.yml",
      workflow_blob_sha_at_run: BLOB,
    })),
    scheduledRuns: scheduled.map((item) => ({
      ...item,
      workflow_name: NAME,
      workflow_path: PATH,
      workflow_url: "https://github.com/owner/repo/actions/workflows/example.yml",
      workflow_blob_sha_at_run: BLOB,
    })),
  });
}

function openFromSignal(signal, number = 9) {
  const body = renderIncidentBody(signal);
  const issue = { number, state: "open", user: BOT, title: renderIncidentTitle(signal), body };
  return { issue, parsed: parseIncidentIssue(issue, { repository: REPOSITORY }) };
}

test("snapshot uses a dedicated event=schedule query even after ten issue runs", async () => {
  const issueRuns = Array.from({ length: 10 }, (_, index) => apiRun({
    id: 100 + index,
    event: "issues",
    created_at: "2026-08-26T11:" + String(59 - index).padStart(2, "0") + ":00.000Z",
  }));
  const pulse = apiRun({ id: 1, event: "schedule", created_at: "2026-08-26T11:50:00.000Z" });
  const fake = fakeGithub({ generalRuns: issueRuns, scheduleRuns: [pulse] });
  const snapshot = await collectSnapshot({
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    contractText: manifestText(),
  });
  assert.equal(snapshot.all_event_runs.length, 2);
  assert.equal(snapshot.scheduled_runs.length, 1);
  assert.equal(snapshot.scheduled_runs[0].id, 1);
  assert.equal(fake.calls.filter((call) => call.path.includes("event=schedule")).length, 1);
});

test("active API workflow absent from the pinned tree becomes RED historical rerun evidence", async () => {
  const older = apiRun({ id: 1, created_at: "2026-08-26T11:50:00.000Z" });
  const newer = apiRun({ id: 2, created_at: "2026-08-26T11:55:00.000Z" });
  const orphan = {
    id: 901,
    name: "Deleted Historical Workflow",
    path: ".github/workflows/deleted-historical.yml",
    state: "active",
  };
  const fake = fakeGithub({
    generalRuns: [newer, older],
    scheduleRuns: [newer, older],
    orphanedApiWorkflows: [orphan],
  });
  const readback = await runSentinelCycle({
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    runId: "api-orphan",
    contractText: manifestText(),
    now: NOW,
    clock: () => NOW,
  });
  assert.equal(readback.overall_state, "RED");
  assert.equal(readback.api_inventory_tree_consistent, false);
  assert.equal(readback.api_orphaned_active_count, 1);
  assert.deepEqual(readback.api_orphaned_active_sample, [{
    workflow_id: 901,
    workflow_name: "Deleted Historical Workflow",
    workflow_path: ".github/workflows/deleted-historical.yml",
    workflow_state: "active",
  }]);
  assert.equal(readback.historical_rerun_surface_neutralized, false);
  assert.equal(fake.calls.every((call) => call.method === "GET"), true);
});

test("truncated workflow tree and source SHA mismatch stop before mutation", async () => {
  const truncated = fakeGithub({ truncated: true });
  await assert.rejects(() => collectSnapshot({
    request: truncated.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    contractText: manifestText(),
  }), /pinned_tree_incomplete/);

  const mismatch = fakeGithub({ treeBlob: "b".repeat(40) });
  await assert.rejects(() => runSentinelCycle({
    request: mismatch.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    runId: "1",
    contractText: manifestText(),
    now: NOW,
  }), /contract_inventory_blob_mismatch/);
  assert.equal(mismatch.calls.some((call) => call.method !== "GET"), false);
});

test("default-branch drift aborts the cycle before all writes", async () => {
  const success = apiRun();
  const fake = fakeGithub({ heads: [COMMIT, "e".repeat(40)], generalRuns: [success], scheduleRuns: [success] });
  await assert.rejects(() => runSentinelCycle({
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    runId: "2",
    contractText: manifestText(),
    now: NOW,
  }), /default_branch_head_drift/);
  assert.equal(fake.calls.some((call) => call.method !== "GET"), false);
});

test("a failed CREATE prevents every planned CLOSE", async () => {
  const active = classify();
  const activeSignal = active.workflow_observations[0].schedule_liveness;
  const fake = fakeGithub({ postError: new Error("simulated_post_failure") });
  await assert.rejects(() => executePlan({
    plan: {
      upserts: [{ action: "CREATE", signal: activeSignal, occurrences: 1 }],
      closes: [{ action: "CLOSE", issue_number: 9, signal: activeSignal }],
    },
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
  }), /simulated_post_failure/);
  assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 0);
});

test("close-time run drift leaves the exact incident open", async () => {
  const staleRun = apiRun({ id: 1, created_at: "2026-08-26T11:00:00.000Z", updated_at: "2026-08-26T11:01:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  const opened = openFromSignal(stale.workflow_observations[0].schedule_liveness, 9);
  const pulse1 = apiRun({ id: 2, created_at: "2026-08-26T11:50:00.000Z" });
  const pulse2 = apiRun({ id: 3, created_at: "2026-08-26T11:55:00.000Z" });
  const fresh = classify({ all: [pulse2, pulse1], scheduled: [pulse2, pulse1] });
  const plan = planIncidentActions(fresh.signals, [opened.parsed]);
  assert.equal(plan.closes.length, 1);
  const newerFailure = apiRun({ id: 4, conclusion: "failure", created_at: "2026-08-26T11:59:00.000Z" });
  const fake = fakeGithub({ scheduleRuns: [newerFailure], issues: [opened.issue] });
  await assert.rejects(() => executePlan({
    plan,
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => NOW,
    allowCloses: true,
  }), /signal_evidence_drift/);
  assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 0);
  assert.equal(fake.issueStore.get(9).state, "open");
});

test("successful close preserves the canonical fingerprint and verifies readback", async () => {
  const staleRun = apiRun({ id: 1, created_at: "2026-08-26T11:00:00.000Z", updated_at: "2026-08-26T11:01:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  const opened = openFromSignal(stale.workflow_observations[0].schedule_liveness, 9);
  const pulse1 = apiRun({ id: 2, created_at: "2026-08-26T11:50:00.000Z", updated_at: "2026-08-26T11:51:00.000Z" });
  const pulse2 = apiRun({ id: 3, created_at: "2026-08-26T11:55:00.000Z", updated_at: "2026-08-26T11:56:00.000Z" });
  const fresh = classify({ all: [pulse2, pulse1], scheduled: [pulse2, pulse1] });
  const plan = planIncidentActions(fresh.signals, [opened.parsed]);
  const fake = fakeGithub({ scheduleRuns: [pulse2, pulse1], issues: [opened.issue] });
  const executed = await executePlan({
    plan,
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => NOW,
    allowCloses: true,
  });
  assert.deepEqual(executed.map((item) => item.action), ["CLOSE"]);
  const closed = fake.issueStore.get(9);
  assert.equal(closed.state, "closed");
  const parsed = parseIncidentIssue(closed, { repository: REPOSITORY });
  assert.equal(parsed.fingerprint, opened.parsed.fingerprint);
  assert.match(closed.body, /incident_class: stale_success/);
});

test("readback exposes RECOVERY_PENDING and remains AMBER", async () => {
  const onePulse = apiRun();
  const fake = fakeGithub({ generalRuns: [onePulse], scheduleRuns: [onePulse] });
  const readback = await runSentinelCycle({
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    runId: "3",
    contractText: manifestText(),
    now: NOW,
  });
  assert.equal(readback.state_counts.RECOVERY_PENDING, 1);
  assert.equal(readback.state_counts.STALE_SUCCESS, 0);
  assert.equal(readback.overall_state, "AMBER");
  assert.equal(readback.actions.length, 0);
  assert.equal(fake.calls.some((call) => call.method !== "GET"), false);
});

test("supporting recovery pulse drift prevents a liveness close", async () => {
  const staleRun = apiRun({ id: 1, created_at: "2026-08-26T11:00:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  const opened = openFromSignal(stale.workflow_observations[0].schedule_liveness, 30);
  const pulse1 = apiRun({ id: 2, created_at: "2026-08-26T11:50:00.000Z" });
  const pulse2 = apiRun({ id: 3, created_at: "2026-08-26T11:55:00.000Z" });
  const fresh = classify({ all: [pulse2, pulse1], scheduled: [pulse2, pulse1] });
  const plan = planIncidentActions(fresh.signals, [opened.parsed]);
  const rerunFailure = apiRun({
    id: 2,
    run_attempt: 2,
    conclusion: "failure",
    created_at: "2026-08-26T11:50:00.000Z",
  });
  const fake = fakeGithub({ scheduleRuns: [pulse2, rerunFailure], issues: [opened.issue] });
  await assert.rejects(() => executePlan({
    plan,
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => NOW,
    allowCloses: true,
  }), /close_quorum_drift/);
  assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 0);
  assert.equal(fake.issueStore.get(30).state, "open");
});

test("CREATE rereads Actions evidence and refuses a superseded missing-run alarm", async () => {
  const missing = classify();
  const active = missing.workflow_observations[0].schedule_liveness;
  const fake = fakeGithub({ scheduleRuns: [apiRun({ id: 200 })] });
  await assert.rejects(() => executePlan({
    plan: { upserts: [{ action: "CREATE", signal: active, occurrences: 1 }], closes: [] },
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => NOW,
  }), /signal_evidence_drift/);
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 0);
});

test("a pulse reaching TTL at close time cannot resolve the incident", async () => {
  const staleRun = apiRun({ id: 1, created_at: "2026-08-26T11:00:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  const opened = openFromSignal(stale.workflow_observations[0].schedule_liveness, 40);
  const pulse1 = apiRun({ id: 2, created_at: "2026-08-26T11:50:00.000Z" });
  const pulse2 = apiRun({ id: 3, created_at: "2026-08-26T11:55:00.000Z" });
  const fresh = classify({ all: [pulse2, pulse1], scheduled: [pulse2, pulse1] });
  const plan = planIncidentActions(fresh.signals, [opened.parsed]);
  const fake = fakeGithub({ scheduleRuns: [pulse2, pulse1], issues: [opened.issue] });
  await assert.rejects(() => executePlan({
    plan,
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => new Date("2026-08-26T12:10:00.000Z"),
    allowCloses: true,
  }), /close_quorum_stale/);
  assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 0);
});

test("CREATE readback must remain open and canonical", async () => {
  const missing = classify();
  const active = missing.workflow_observations[0].schedule_liveness;
  const fake = fakeGithub({ postState: "closed" });
  await assert.rejects(() => executePlan({
    plan: { upserts: [{ action: "CREATE", signal: active, occurrences: 1 }], closes: [] },
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => NOW,
  }), /incident_issue_readback_mismatch/);
});

test("source-mismatched run provenance remains visible without shadow mutations", async () => {
  const mismatched = apiRun({ id: 500, head_sha: "e".repeat(40) });
  const fake = fakeGithub({
    runBlob: "b".repeat(40),
    generalRuns: [mismatched],
    scheduleRuns: [mismatched],
  });
  const readback = await runSentinelCycle({
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    runId: "source-mismatch",
    contractText: manifestText(),
    now: NOW,
    clock: () => NOW,
  });
  assert.equal(readback.overall_state, "RED");
  assert.deepEqual(readback.actions, []);
  assert.equal(readback.diagnostic_would_create, 2);
  assert.equal(readback.execution_upserts_quarantined, 1);
  assert.equal(readback.scheduled_upserts_quarantined, 1);
  assert.equal([...fake.issueStore.values()].filter((issue) => issue.state === "open").length, 0);
  assert.equal(fake.calls.every((call) => call.method === "GET"), true);
});

test("fork and pull-request rows are ignored without hiding trusted default-branch evidence", async () => {
  const untrusted = apiRun({
    id: 510,
    event: "pull_request",
    head_repository: { full_name: "fork/repo" },
  });
  const trusted = apiRun({ id: 509 });
  const fake = fakeGithub({ generalRuns: [untrusted, trusted], scheduleRuns: [trusted] });
  const snapshot = await collectSnapshot({
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    contractText: manifestText(),
  });
  assert.deepEqual(snapshot.all_event_runs.map((run) => run.id), [509]);
  assert.equal(snapshot.scheduled_runs[0].id, 509);
});

test("workflow state drift before close leaves the incident open", async () => {
  const staleRun = apiRun({ id: 520, created_at: "2026-08-26T11:00:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  const opened = openFromSignal(stale.workflow_observations[0].schedule_liveness, 520);
  const pulse1 = apiRun({ id: 521, created_at: "2026-08-26T11:50:00.000Z" });
  const pulse2 = apiRun({ id: 522, created_at: "2026-08-26T11:55:00.000Z" });
  const fresh = classify({ all: [pulse2, pulse1], scheduled: [pulse2, pulse1] });
  const plan = planIncidentActions(fresh.signals, [opened.parsed]);
  const fake = fakeGithub({
    workflowStates: ["active", "disabled_manually"],
    scheduleRuns: [pulse2, pulse1],
    issues: [opened.issue],
  });
  await assert.rejects(() => executePlan({
    plan,
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => NOW,
    allowCloses: true,
  }), /workflow_live_identity_or_state_drift/);
  assert.equal(fake.issueStore.get(520).state, "open");
  assert.equal(fake.calls.some((call) => call.method === "PATCH"), false);
});

test("ambiguous close response is compensated back to the exact open incident", async () => {
  const staleRun = apiRun({ id: 530, created_at: "2026-08-26T11:00:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  const opened = openFromSignal(stale.workflow_observations[0].schedule_liveness, 530);
  const pulse1 = apiRun({ id: 531, created_at: "2026-08-26T11:50:00.000Z" });
  const pulse2 = apiRun({ id: 532, created_at: "2026-08-26T11:55:00.000Z" });
  const fresh = classify({ all: [pulse2, pulse1], scheduled: [pulse2, pulse1] });
  const plan = planIncidentActions(fresh.signals, [opened.parsed]);
  const fake = fakeGithub({
    scheduleRuns: [pulse2, pulse1],
    issues: [opened.issue],
    closePatchErrorAfterApply: new Error("ambiguous_close_effect"),
  });
  await assert.rejects(() => executePlan({
    plan,
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => NOW,
    allowCloses: true,
  }), /incident_close_compensated:ambiguous_close_effect/);
  assert.equal(fake.issueStore.get(530).state, "open");
  assert.equal(fake.issueStore.get(530).body, opened.issue.body);
});

test("post-close external state drift triggers compensating reopen", async () => {
  const staleRun = apiRun({ id: 540, created_at: "2026-08-26T11:00:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  const opened = openFromSignal(stale.workflow_observations[0].schedule_liveness, 540);
  const pulse1 = apiRun({ id: 541, created_at: "2026-08-26T11:50:00.000Z" });
  const pulse2 = apiRun({ id: 542, created_at: "2026-08-26T11:55:00.000Z" });
  const fresh = classify({ all: [pulse2, pulse1], scheduled: [pulse2, pulse1] });
  const plan = planIncidentActions(fresh.signals, [opened.parsed]);
  const fake = fakeGithub({
    workflowStates: ["active", "active", "disabled_manually"],
    scheduleRuns: [pulse2, pulse1],
    issues: [opened.issue],
  });
  await assert.rejects(() => executePlan({
    plan,
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    clock: () => NOW,
    allowCloses: true,
  }), /incident_close_compensated:workflow_live_identity_or_state_drift/);
  assert.equal(fake.issueStore.get(540).state, "open");
  assert.equal(fake.issueStore.get(540).body, opened.issue.body);
});

test("production cycle quarantines every close and cannot certify GREEN", async () => {
  const staleRun = apiRun({ id: 550, created_at: "2026-08-26T11:00:00.000Z" });
  const stale = classify({ all: [staleRun], scheduled: [staleRun] });
  const opened = openFromSignal(stale.workflow_observations[0].schedule_liveness, 550);
  const pulse1 = apiRun({ id: 551, created_at: "2026-08-26T11:50:00.000Z" });
  const pulse2 = apiRun({ id: 552, created_at: "2026-08-26T11:55:00.000Z" });
  const fake = fakeGithub({ generalRuns: [pulse2, pulse1], scheduleRuns: [pulse2, pulse1], issues: [opened.issue] });
  const readback = await runSentinelCycle({
    request: fake.request,
    repository: REPOSITORY,
    defaultBranch: BRANCH,
    pinnedCommit: COMMIT,
    runId: "quarantine",
    contractText: manifestText(),
    now: NOW,
    clock: () => NOW,
  });
  assert.equal(readback.overall_state, "AMBER");
  assert.equal(readback.execution_history_complete, false);
  assert.equal(readback.closures_quarantined, 1);
  assert.deepEqual(readback.actions, []);
  assert.equal(fake.issueStore.get(550).state, "open");
  assert.equal(fake.calls.some((call) => call.method === "PATCH"), false);
});

test("production workflow grants read scopes only and declares no write authority", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/runtime-anomaly-sentinel.yml", import.meta.url), "utf8");
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^    permissions:\n      actions: read\n      contents: read\n      issues: read$/m);
  assert.doesNotMatch(workflow, /:\s*write\b|write-all|id-token:/i);
});

test("production cycle is GET-only across failure, existing issue, disabled, source mismatch, recovery, and tampered issue", async () => {
  const missing = classify();
  const missingSignal = missing.workflow_observations[0].schedule_liveness;
  const canonical = openFromSignal(missingSignal, 610).issue;
  const older = apiRun({ id: 20, created_at: "2026-08-26T11:50:00.000Z", updated_at: "2026-08-26T11:51:00.000Z" });
  const newer = apiRun({ id: 21, created_at: "2026-08-26T11:55:00.000Z", updated_at: "2026-08-26T11:56:00.000Z" });
  const scenarios = [
    { name: "active failure", options: {} },
    { name: "existing canonical issue", options: { issues: [canonical] } },
    { name: "disabled workflow with history", options: { workflowState: "disabled_manually", generalRuns: [newer], scheduleRuns: [newer, older] } },
    { name: "source mismatch", options: { runBlob: "b".repeat(40), generalRuns: [newer], scheduleRuns: [newer, older] } },
    { name: "healthy recovery", options: { generalRuns: [newer, older], scheduleRuns: [newer, older], issues: [canonical] } },
    { name: "tampered issue body", options: { issues: [{ ...canonical, body: canonical.body + "\n- state: **HEALTHY**" }] } },
  ];
  for (const scenario of scenarios) {
    const fake = fakeGithub(scenario.options);
    const readback = await runSentinelCycle({
      request: fake.request,
      repository: REPOSITORY,
      defaultBranch: BRANCH,
      pinnedCommit: COMMIT,
      runId: scenario.name,
      contractText: manifestText(),
      now: NOW,
      clock: () => NOW,
    });
    assert.equal(fake.calls.every((call) => call.method === "GET"), true, scenario.name);
    assert.deepEqual(readback.actions, [], scenario.name);
    assert.equal(readback.write_mode, "READ_ONLY_SHADOW", scenario.name);
    assert.equal(readback.mutation_authority, "NONE", scenario.name);
    assert.equal(readback.writes_allowed, false, scenario.name);
    assert.notEqual(readback.overall_state, "GREEN", scenario.name);
    assert.equal(readback.diagnostic_incident_plan_authoritative, false, scenario.name);
  }
});

test("GitHub request budget fails closed before a 10-minute read-only observer can exhaust the token", async () => {
  const request = createGithubRequest({
    token: "test-token",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  });
  for (let index = 0; index < 100; index += 1) await request("/budget/" + index);
  await assert.rejects(() => request("/budget/overflow"), /github_api_request_budget_exceeded/);
});

test("read-only shadow quarantines every planned mutation", () => {
  const action = (kind, axis, fingerprint) => ({ action: kind, signal: { axis, fingerprint } });
  const selected = selectExecutablePlan({
    upserts: [
      action("UPDATE", "scheduled_liveness", "z"),
      action("CREATE", "scheduled_liveness", "c"),
      action("UPDATE", "scheduled_liveness", "y"),
      action("CREATE", "scheduled_liveness", "a"),
      action("CREATE", "scheduled_liveness", "b"),
      action("CREATE", "execution_health", "execution"),
    ],
    closes: [{ action: "CLOSE" }],
  });
  assert.deepEqual(selected.plan.upserts, []);
  assert.deepEqual(selected.plan.closes, []);
  assert.equal(selected.execution_upserts_quarantined, 1);
  assert.equal(selected.scheduled_upserts_deferred, 5);
});
