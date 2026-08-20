import assert from "node:assert/strict";
import test from "node:test";
import { runOne, validateTask } from "./exposure_queue_worker.mjs";

const fixedNowMs = Date.parse("2026-08-20T12:00:00.000Z");
const now = () => fixedNowMs;

function task(overrides = {}) {
  return {
    schema_version: 1,
    task_id: "canary-20260820-001",
    project_id: "JCC_RUNTIME",
    capability: "exposure.lookup",
    mode: "passive",
    asset: "example.com",
    provider: "auto",
    page_size: 100,
    max_pages: 1,
    max_query_credits: 1,
    created_at: "2026-08-20T11:55:00.000Z",
    expires_at: "2026-08-21T11:55:00.000Z",
    authorization: {
      basis: "DOCUMENTATION_RESERVED",
      approved_by: "owner",
      approved_at: "2026-08-20T11:54:00.000Z",
      scope: "passive_internet_exposure",
      active_scanning: false,
    },
    ...overrides,
  };
}

function jsonResponse(document, status = 200) {
  return new Response(JSON.stringify(document), { status, headers: { "content-type": "application/json" } });
}

function githubFile(document, sha = "a".repeat(40)) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  return { encoding: "base64", content: Buffer.from(text).toString("base64"), sha };
}

test("task validation accepts a bounded passive documentation canary", () => {
  const parsed = validateTask(task(), "canary-20260820-001.json", { now });
  assert.equal(parsed.asset, "example.com");
  assert.equal(parsed.asset_type, "domain");
});

test("task validation rejects active scanning and non-reserved documentation targets", () => {
  assert.throws(() => validateTask(task({ mode: "active" }), "canary-20260820-001.json", { now }), { code: "PRIVATE_TASK_CAPABILITY_INVALID" });
  assert.throws(() => validateTask(task({ asset: "private.example" }), "canary-20260820-001.json", { now }), { code: "PRIVATE_TASK_AUTHORIZATION_INVALID" });
});

test("idle queue performs no provider request", async () => {
  const calls = [];
  const result = await runOne({
    env: { COMMAND_CENTER_TOKEN: "private-token" },
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.authorization });
      return jsonResponse({ message: "not found" }, 404);
    },
  });
  assert.equal(result.status, "IDLE");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer private-token");
});

test("one live task writes a fail-closed start marker, executes Shodan preflight, and persists private evidence", async () => {
  const privateTask = task();
  const puts = [];
  const providerCalls = [];
  let resultReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com") {
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        puts.push(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")));
        return jsonResponse({ content: { sha: `${puts.length}`.repeat(40) } }, puts.length === 1 ? 201 : 200);
      }
      if (parsed.pathname.endsWith("/runtime/exposure/queue/pending")) {
        return jsonResponse([{ type: "file", name: `${privateTask.task_id}.json`, path: `runtime/exposure/queue/pending/${privateTask.task_id}.json` }]);
      }
      if (parsed.pathname.endsWith(`/runtime/exposure/queue/pending/${privateTask.task_id}.json`)) {
        return jsonResponse(githubFile(privateTask));
      }
      if (parsed.pathname.endsWith(`/runtime/exposure/results/${privateTask.task_id}.json`)) {
        resultReads += 1;
        return jsonResponse({ message: "not found" }, 404);
      }
      throw new Error(`unexpected GitHub path ${parsed.pathname}`);
    }
    providerCalls.push({ host: parsed.hostname, path: parsed.pathname, query: parsed.searchParams.get("query") });
    assert.equal(parsed.searchParams.get("key"), "shodan-secret");
    if (parsed.pathname === "/shodan/host/count") return jsonResponse({ total: 1, matches: [] });
    if (parsed.pathname === "/api-info") return jsonResponse({ query_credits: 5 });
    if (parsed.pathname === "/shodan/host/search") return jsonResponse({ total: 1, matches: [{ ip_str: "192.0.2.10", port: 443, hostnames: ["example.com"] }] });
    throw new Error(`unexpected provider path ${parsed.pathname}`);
  };

  const result = await runOne({
    env: { COMMAND_CENTER_TOKEN: "private-token", SHODAN_API_KEY: "shodan-secret" },
    now,
    fetchImpl,
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.provider, "shodan");
  assert.equal(result.query_credits_spent, 1);
  assert.equal(resultReads, 1);
  assert.equal(puts.length, 2);
  assert.equal(puts[0].status, "STARTED_FAIL_CLOSED");
  assert.equal(puts[1].status, "COMPLETE");
  assert.equal(puts[1].observations.length, 1);
  assert.deepEqual(providerCalls.map((call) => call.path), [
    "/shodan/host/count",
    "/api-info",
    "/shodan/host/search",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /example\.com|192\.0\.2\.10|shodan-secret|private-token/);
});

test("an existing STARTED marker blocks automatic re-execution", async () => {
  const privateTask = task();
  let providerCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "api.github.com") {
      providerCalls += 1;
      throw new Error("provider must not run");
    }
    if (parsed.pathname.endsWith("/runtime/exposure/queue/pending")) {
      return jsonResponse([{ type: "file", name: `${privateTask.task_id}.json`, path: `runtime/exposure/queue/pending/${privateTask.task_id}.json` }]);
    }
    if (parsed.pathname.endsWith(`/runtime/exposure/queue/pending/${privateTask.task_id}.json`)) return jsonResponse(githubFile(privateTask));
    if (parsed.pathname.endsWith(`/runtime/exposure/results/${privateTask.task_id}.json`)) {
      return jsonResponse(githubFile({ status: "STARTED_FAIL_CLOSED" }, "b".repeat(40)));
    }
    throw new Error(`unexpected path ${parsed.pathname} ${options.method}`);
  };
  const result = await runOne({ env: { COMMAND_CENTER_TOKEN: "private-token", SHODAN_API_KEY: "secret" }, fetchImpl, now });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(providerCalls, 0);
});

test("completed queue entries are skipped so a later task can execute", async () => {
  const first = task({ task_id: "canary-20260820-001" });
  const second = task({ task_id: "canary-20260820-002" });
  const puts = [];
  let providerCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "api.github.com") {
      providerCalls += 1;
      if (parsed.pathname === "/shodan/host/count") return jsonResponse({ total: 0, matches: [] });
      throw new Error(`unexpected provider path ${parsed.pathname}`);
    }
    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      puts.push(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")));
      return jsonResponse({ content: { sha: `${puts.length + 2}`.repeat(40) } }, puts.length === 1 ? 201 : 200);
    }
    if (parsed.pathname.endsWith("/runtime/exposure/queue/pending")) {
      return jsonResponse([first, second].map((entry) => ({
        type: "file",
        name: `${entry.task_id}.json`,
        path: `runtime/exposure/queue/pending/${entry.task_id}.json`,
      })));
    }
    if (parsed.pathname.endsWith(`/runtime/exposure/queue/pending/${first.task_id}.json`)) return jsonResponse(githubFile(first));
    if (parsed.pathname.endsWith(`/runtime/exposure/queue/pending/${second.task_id}.json`)) return jsonResponse(githubFile(second));
    if (parsed.pathname.endsWith(`/runtime/exposure/results/${first.task_id}.json`)) return jsonResponse(githubFile({ status: "COMPLETE" }));
    if (parsed.pathname.endsWith(`/runtime/exposure/results/${second.task_id}.json`)) return jsonResponse({ message: "not found" }, 404);
    throw new Error(`unexpected path ${parsed.pathname}`);
  };
  const result = await runOne({
    env: { COMMAND_CENTER_TOKEN: "private-token", SHODAN_API_KEY: "secret" },
    fetchImpl,
    now,
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.query_credits_spent, 0);
  assert.equal(providerCalls, 1);
  assert.equal(puts.length, 2);
  assert.equal(puts[0].task_id, second.task_id);
});

test("a completed receipt larger than the task limit remains readable and blocks re-execution", async () => {
  const privateTask = task();
  const largeReceipt = {
    status: "PAGE_LIMIT_REACHED",
    observations: Array.from({ length: 100 }, (_, index) => ({
      observation_id: String(index),
      padding: "x".repeat(900),
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(largeReceipt)) > 64 * 1024);
  let providerCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "api.github.com") {
      providerCalls += 1;
      throw new Error("provider must not run");
    }
    if (parsed.pathname.endsWith("/runtime/exposure/queue/pending")) {
      return jsonResponse([{
        type: "file",
        name: `${privateTask.task_id}.json`,
        path: `runtime/exposure/queue/pending/${privateTask.task_id}.json`,
      }]);
    }
    if (parsed.pathname.endsWith(`/runtime/exposure/queue/pending/${privateTask.task_id}.json`)) return jsonResponse(githubFile(privateTask));
    if (parsed.pathname.endsWith(`/runtime/exposure/results/${privateTask.task_id}.json`)) return jsonResponse(githubFile(largeReceipt));
    throw new Error(`unexpected path ${parsed.pathname}`);
  };
  const result = await runOne({ env: { COMMAND_CENTER_TOKEN: "private-token", SHODAN_API_KEY: "secret" }, fetchImpl, now });
  assert.equal(result.status, "IDLE");
  assert.equal(providerCalls, 0);
});
