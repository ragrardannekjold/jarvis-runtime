import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CapabilityRegistry,
  EVENT_TYPE,
  PublicTaskDispatcher,
  WorkerError,
  createBuboAdapter,
  createPublicRuntime,
  handleRepositoryDispatch,
} from "../src/index.mjs";

const RECORD_ID = "0123456789abcdef0123456789abcdef";
const RAW_TENDER = JSON.stringify({
  data: {
    id: RECORD_ID,
    tenderID: "UA-2026-02-21-000440-a",
    status: "active",
    procurementMethodType: "aboveThresholdUA",
    date: "2026-02-21T10:00:00+02:00",
    dateModified: "2026-08-31T11:00:00+03:00",
    title: "must never be emitted",
    description: "must never be emitted",
    coordinates: { latitude: 1, longitude: 2 },
    procuringEntity: {
      name: "not emitted to minimize data",
      identifier: { scheme: "UA-EDR", id: "12345678" },
      kind: "general",
      contactPoint: { email: "private@example.invalid", telephone: "+000" },
      address: { locality: "not emitted" },
    },
    value: { amount: 61798212.7, currency: "UAH", valueAddedTaxIncluded: true },
    tenderPeriod: {
      startDate: "2026-02-21T10:00:00+02:00",
      endDate: "2026-03-01T10:00:00+02:00",
    },
    items: [{ description: "not emitted", deliveryAddress: { locality: "x" } }],
    bids: [{}],
    complaints: [],
    documents: [{ url: "not emitted" }],
    awards: [{ id: "award" }],
    contracts: [
      {
        id: "contract-1",
        awardID: "award-1",
        status: "active",
        dateSigned: "2026-03-10T12:00:00+02:00",
        value: { amount: 61798212.7, currency: "UAH", valueAddedTaxIncluded: true },
      },
    ],
  },
});

function response(raw = RAW_TENDER, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return raw;
    },
  };
}

function cuckooEnvelope(overrides = {}) {
  return {
    task_id: "donbas.procurement.001",
    case_id: "DON-V2-01",
    worker: "cuckoo",
    capability: "prozorro_snapshot_v1",
    sensitivity: "PUBLIC",
    payload: { record_id: RECORD_ID },
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WorkerError);
    assert.equal(error.code, code);
    return true;
  });
}

test("Cuckoo fetches only the hard-coded official URL and emits a narrow snapshot", async () => {
  const calls = [];
  const runtime = createPublicRuntime({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response();
    },
    now: () => "2026-09-01T12:00:00.000Z",
  });

  const output = await runtime.dispatcher.dispatch(cuckooEnvelope());
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0],
    `https://public.api.openprocurement.org/api/2.5/tenders/${RECORD_ID}`,
  );
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(output.result.schema, "public.prozorro_snapshot.v1");
  assert.equal(output.result.normalized.counts.contracts, 1);
  assert.equal(output.result.normalized.value.amount, 61798212.7);
  assert.equal(
    output.result.raw_commitment.sha256,
    createHash("sha256").update(RAW_TENDER).digest("hex"),
  );

  const serialized = JSON.stringify(output);
  for (const secret of [
    "must never be emitted",
    "private@example.invalid",
    "not emitted",
    "latitude",
    "longitude",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("Cuckoo rejects invalid record IDs before fetch", async () => {
  let calls = 0;
  const runtime = createPublicRuntime({
    fetchImpl: async () => {
      calls += 1;
      return response();
    },
  });
  await expectCode(
    runtime.dispatcher.dispatch(
      cuckooEnvelope({ payload: { record_id: "UA-2026-not-a-record-id" } }),
    ),
    "INVALID_RECORD_ID",
  );
  assert.equal(calls, 0);
});

test("Cuckoo rejects HTTP, malformed JSON, and mismatched source identifiers", async (t) => {
  await t.test("HTTP", async () => {
    const { dispatcher } = createPublicRuntime({
      fetchImpl: async () => response("{}", 404),
    });
    await expectCode(dispatcher.dispatch(cuckooEnvelope()), "SOURCE_HTTP_ERROR");
  });
  await t.test("JSON", async () => {
    const { dispatcher } = createPublicRuntime({
      fetchImpl: async () => response("not-json"),
    });
    await expectCode(dispatcher.dispatch(cuckooEnvelope()), "SOURCE_INVALID_JSON");
  });
  await t.test("record mismatch", async () => {
    const { dispatcher } = createPublicRuntime({
      fetchImpl: async () =>
        response(JSON.stringify({ data: { id: "f".repeat(32) } })),
    });
    await expectCode(dispatcher.dispatch(cuckooEnvelope()), "SOURCE_ID_MISMATCH");
  });
});

test("BUBO deterministically creates the required candidate evidence packet", async () => {
  const { dispatcher } = createPublicRuntime({
    fetchImpl: async () => response(),
    now: () => "2026-09-01T12:00:00.000Z",
  });
  const cuckoo = await dispatcher.dispatch(cuckooEnvelope());
  const adapter = createBuboAdapter();
  const payload = { cuckoo_result: cuckoo.result };
  const first = await adapter(payload);
  const second = await adapter(structuredClone(payload));
  assert.deepEqual(first, second);
  for (const key of [
    "CLAIM",
    "EVIDENCE",
    "SOURCE_GENEALOGY",
    "CONTRADICTIONS",
    "CONFIDENCE",
    "NEXT_FALSIFIER",
    "SENSITIVITY",
  ]) {
    assert.ok(Object.hasOwn(first, key), key);
  }
  assert.equal(first.canonical_admission, "PENDING_VERIFIER");
  assert.equal(first.SENSITIVITY, "PUBLIC");
  assert.match(first.CONFIDENCE.basis, /no inference of wrongdoing/i);
});

test("dispatcher enforces exact schema, public sensitivity, and capability matching", async (t) => {
  const { dispatcher } = createPublicRuntime({ fetchImpl: async () => response() });

  await t.test("extra envelope key", async () => {
    await expectCode(
      dispatcher.dispatch({ ...cuckooEnvelope(), priority: "urgent" }),
      "INVALID_ENVELOPE",
    );
  });
  await t.test("non-public", async () => {
    await expectCode(
      dispatcher.dispatch(cuckooEnvelope({ sensitivity: "PRIVATE" })),
      "SENSITIVITY_REJECTED",
    );
  });
  await t.test("worker/capability mismatch", async () => {
    await expectCode(
      dispatcher.dispatch(cuckooEnvelope({ worker: "bubo" })),
      "CAPABILITY_MISMATCH",
    );
  });
  await t.test("tactical/private field", async () => {
    await expectCode(
      dispatcher.dispatch(
        cuckooEnvelope({ payload: { record_id: RECORD_ID, coordinates: [1, 2] } }),
      ),
      "FORBIDDEN_FIELD",
    );
  });
});

test("dispatcher accepts JSON text but still enforces the exact envelope", async () => {
  const { dispatcher } = createPublicRuntime({
    fetchImpl: async () => response(),
    now: () => "2026-09-01T12:00:00.000Z",
  });
  const result = await dispatcher.dispatchJson(JSON.stringify(cuckooEnvelope()));
  assert.equal(result.task_id, cuckooEnvelope().task_id);
  await expectCode(dispatcher.dispatchJson("{not-json"), "INVALID_JSON");
});

test("dispatcher is idempotent and binds each task ID to immutable input", async () => {
  let fetches = 0;
  const { dispatcher } = createPublicRuntime({
    fetchImpl: async () => {
      fetches += 1;
      return response();
    },
    now: () => "2026-09-01T12:00:00.000Z",
  });
  const first = await dispatcher.dispatch(cuckooEnvelope());
  const duplicate = await dispatcher.dispatch(structuredClone(cuckooEnvelope()));
  assert.deepEqual(duplicate, first);
  assert.equal(fetches, 1);

  await expectCode(
    dispatcher.dispatch(
      cuckooEnvelope({ payload: { record_id: "f".repeat(32) } }),
    ),
    "TASK_ID_CONFLICT",
  );
});

test("concurrent duplicate events execute the adapter once", async () => {
  let resolveFetch;
  let fetches = 0;
  const { dispatcher } = createPublicRuntime({
    fetchImpl: async () => {
      fetches += 1;
      await new Promise((resolve) => {
        resolveFetch = resolve;
      });
      return response();
    },
    now: () => "2026-09-01T12:00:00.000Z",
  });
  const first = dispatcher.dispatch(cuckooEnvelope());
  const duplicate = dispatcher.dispatch(structuredClone(cuckooEnvelope()));
  resolveFetch();
  assert.deepEqual(await duplicate, await first);
  assert.equal(fetches, 1);
});

test("revocation prevents a late adapter completion from committing a stale result", async () => {
  let release;
  const registry = new CapabilityRegistry().register(
    "cuckoo",
    "prozorro_snapshot_v1",
    async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { candidate_only: true };
    },
  );
  const dispatcher = new PublicTaskDispatcher({ registry });
  const pending = dispatcher.dispatch(cuckooEnvelope());
  assert.equal(dispatcher.revokeTask(cuckooEnvelope().task_id), true);
  release();
  await expectCode(pending, "STALE_RESULT");
  assert.equal(dispatcher.inspectTask(cuckooEnvelope().task_id).state, "REVOKED");
});

test("repository dispatch bridge triggers work only for the exact ready event", async () => {
  const { dispatcher } = createPublicRuntime({
    fetchImpl: async () => response(),
    now: () => "2026-09-01T12:00:00.000Z",
  });
  const result = await handleRepositoryDispatch(
    { event_type: EVENT_TYPE, client_payload: cuckooEnvelope() },
    dispatcher,
  );
  assert.equal(result.task_id, cuckooEnvelope().task_id);
  await expectCode(
    handleRepositoryDispatch(
      { event_type: "schedule.hourly", client_payload: cuckooEnvelope() },
      dispatcher,
    ),
    "EVENT_TYPE_MISMATCH",
  );
});

test("implementation contains no runtime GPT dependency", async () => {
  for (const file of [
    "../src/dispatcher.mjs",
    "../src/runtime.mjs",
    "../src/adapters/cuckoo.mjs",
    "../src/adapters/bubo.mjs",
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /openai|chatgpt|gpt[-_ ]?\d/i);
  }
});

test("event runtime has no schedule, dynamic shell, or user-controlled URL", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/public-outsource-worker.yml", import.meta.url),
    "utf8",
  );
  const entry = await readFile(
    new URL("../integration/github_action_entry.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.match(workflow, /github\.actor == github\.repository_owner/);
  assert.doesNotMatch(entry, /node:child_process|execFile|spawn\(/);
  assert.doesNotMatch(entry, /client_payload.*url|payload.*command/);
  assert.match(entry, /const GITHUB_API = "https:\/\/api\.github\.com"/);
});
