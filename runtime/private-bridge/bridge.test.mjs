import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";

import {
  BRIDGE_BLOCKED,
  PRIVATE_REPOSITORY_NAME,
  PrivateBridgeBlockedError,
  createGitHubAppJwt,
  isolatedChildEnv,
  loadBridgeCredentials,
  mintInstallationToken,
  privateResultRecord,
  publicBridgeReceipt,
  renderPublicBridgeReceipt,
  resolvePrivateMainCommit,
  sha256,
  validatePrivateCanaryTask,
  validatePrivateResultRecord,
} from "./bridge.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

function decodePart(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function validTask(overrides = {}) {
  return {
    schema_version: 3,
    task_id: "ai109-private-bridge-canary",
    project_id: "INV-CONTROL-PLANE",
    capability: "investigation.source_delta_external_runtime_canary",
    mode: "private_external_runtime_canary",
    provider: "controlled_https",
    purpose: "AI109_PRIVATE_BRIDGE_CANARY",
    created_at: "2026-09-02T10:00:00Z",
    expires_at: "2026-09-03T10:00:00Z",
    authorization: {
      basis: "OWNER_AUTHORIZED_PRIVATE_BRIDGE_CANARY",
      approved_by: "owner",
      approved_at: "2026-09-02T10:00:00Z",
      scope: "private_external_runtime_canary",
      active_scanning: false,
      public_targeting_output: false,
      private_normalized_observations: true,
    },
    ...overrides,
  };
}

function validReceipts() {
  const first = {
    receipt_sha256: "1".repeat(64),
    terminal_readback_status: "VERIFIED_DONE",
  };
  const restart = {
    receipt_sha256: "2".repeat(64),
    terminal_readback_status: "VERIFIED_DONE",
    terminal_readback_survived_restart: true,
    event_count: 1,
    task_count: 1,
    mission_count: 1,
    duplicate_submissions: 1,
    no_change_collapsed: 1,
    continuation_without_chat: true,
    next_advanced: true,
  };
  return { first, restart };
}

function validPrivateResult() {
  const task = validTask();
  const { first, restart } = validReceipts();
  return privateResultRecord({
    task,
    requestSha256: sha256(task),
    privateTaskSourceSha: "a".repeat(40),
    privateMainCommitSha: "b".repeat(40),
    archiveSha256: "c".repeat(64),
    first,
    restart,
    startedAt: "2026-09-02T12:00:00Z",
    completedAt: "2026-09-02T12:01:00Z",
  });
}

test("missing GitHub App credentials fail closed with one bounded state", () => {
  assert.throws(
    () => loadBridgeCredentials({}),
    (error) => error instanceof PrivateBridgeBlockedError && error.code === BRIDGE_BLOCKED,
  );
  assert.throws(
    () => loadBridgeCredentials({
      JARVIS_PRIVATE_BRIDGE_APP_ID: "1",
      JARVIS_PRIVATE_BRIDGE_PRIVATE_KEY: "not-a-key",
      JARVIS_PRIVATE_BRIDGE_INSTALLATION_ID: "2",
    }),
    /BLOCKED_CREDENTIAL_PROVISIONING/,
  );
});

test("GitHub App JWT is short-lived RS256 and binds the app id", () => {
  const nowMs = Date.parse("2026-09-02T12:00:00Z");
  const jwt = createGitHubAppJwt({ appId: "12345", privateKey: PRIVATE_KEY_PEM, nowMs });
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  assert.equal(jwt.split(".").length, 3);
  assert.deepEqual(decodePart(headerPart), { alg: "RS256", typ: "JWT" });
  const payload = decodePart(payloadPart);
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, Math.floor(nowMs / 1000) - 60);
  assert.equal(payload.exp, Math.floor(nowMs / 1000) + 8 * 60);
  assert.ok(payload.exp - payload.iat < 10 * 60);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  assert.equal(verifier.verify(PUBLIC_KEY_PEM, Buffer.from(signaturePart, "base64url")), true);
});

test("sha256 hashes raw bytes rather than their serialized representation", () => {
  const bytes = Buffer.from([0, 1, 2, 3, 255]);
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256(bytes), expected);
  assert.notEqual(sha256(bytes), sha256(bytes.toString("base64")));
});

test("installation token request is downscoped to one private repository and requested contents permission", async () => {
  const calls = [];
  const nowMs = Date.parse("2026-09-02T12:00:00Z");
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 201,
      async json() {
        return {
          token: "ghs_test_token_that_is_long_enough_123456789",
          expires_at: "2026-09-02T13:00:00Z",
        };
      },
    };
  };
  const credentials = { appId: "12345", installationId: "67890", privateKey: PRIVATE_KEY_PEM };
  const result = await mintInstallationToken({ credentials, permission: "read", fetchImpl, nowMs });
  assert.equal(result.permission, "read");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/app\/installations\/67890\/access_tokens$/);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.repositories, [PRIVATE_REPOSITORY_NAME]);
  assert.deepEqual(body.permissions, { contents: "read" });
  assert.match(calls[0].options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
});

test("private main revision is resolved to an exact commit before archive fetch", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { sha: "d".repeat(40) };
      },
    };
  };
  const commit = await resolvePrivateMainCommit({ token: "short-lived-token", fetchImpl });
  assert.equal(commit, "d".repeat(40));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/repos\/ragrardannekjold\/jarvis-command-center\/commits\/main$/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer short-lived-token");
});

test("private task contract forbids traversal, active scanning, public targeting and stale authorization", () => {
  const nowMs = Date.parse("2026-09-02T12:00:00Z");
  assert.doesNotThrow(() => validatePrivateCanaryTask(validTask(), "ai109-private-bridge-canary", nowMs));
  assert.throws(
    () => validatePrivateCanaryTask(validTask(), "../escape", nowMs),
    /invalid_private_task_id/,
  );
  assert.throws(
    () => validatePrivateCanaryTask(validTask({
      authorization: { ...validTask().authorization, active_scanning: true },
    }), "ai109-private-bridge-canary", nowMs),
    /active_scanning_forbidden/,
  );
  assert.throws(
    () => validatePrivateCanaryTask(validTask({
      authorization: { ...validTask().authorization, public_targeting_output: true },
    }), "ai109-private-bridge-canary", nowMs),
    /public_targeting_output_forbidden/,
  );
  assert.throws(
    () => validatePrivateCanaryTask(validTask({ expires_at: "2026-09-02T11:59:59Z" }), "ai109-private-bridge-canary", nowMs),
    /private_task_expired/,
  );
});

test("private result is content-addressed and tampering fails closed", () => {
  const task = validTask();
  const result = validPrivateResult();
  assert.doesNotThrow(() => validatePrivateResultRecord(result, {
    taskId: task.task_id,
    capability: task.capability,
    requestSha256: sha256(task),
  }));
  const tampered = structuredClone(result);
  tampered.completed_at = "2026-09-02T12:02:00Z";
  assert.throws(() => validatePrivateResultRecord(tampered, {
    taskId: task.task_id,
    capability: task.capability,
    requestSha256: sha256(task),
  }), /private_result_integrity_mismatch/);
});

test("private result cannot promote facts or claim a live watcher", () => {
  const task = validTask();
  const result = validPrivateResult();
  const weakened = structuredClone(result);
  weakened.parent_investigation_effect.fact_promotion = true;
  const { result_sha256: _old, ...material } = weakened;
  weakened.result_sha256 = sha256(material);
  assert.throws(() => validatePrivateResultRecord(weakened, {
    taskId: task.task_id,
    capability: task.capability,
    requestSha256: sha256(task),
  }), /private_result_parent_effect_invalid/);
});

test("private bridge child environment never inherits GitHub or App credentials", () => {
  const child = isolatedChildEnv({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    GITHUB_TOKEN: "public-token",
    GH_TOKEN: "gh-token",
    JARVIS_PRIVATE_BRIDGE_APP_ID: "123",
    JARVIS_PRIVATE_BRIDGE_PRIVATE_KEY: "PRIVATE-SECRET",
    JARVIS_PRIVATE_BRIDGE_INSTALLATION_ID: "456",
    UNRELATED_SECRET: "must-not-be-inherited-because-env-is-allowlist-not-copy",
  }, { PYTHONPATH: "/tmp/private/src" });
  assert.deepEqual(child, {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONPATH: "/tmp/private/src",
  });
});

test("public receipt is finite and cannot contain token, private stdout, stderr or payload", () => {
  const privateResult = {
    result_sha256: "a".repeat(64),
    result: {
      terminal_readback_status: "VERIFIED_DONE",
      terminal_readback_survived_restart: true,
      event_count: 1,
      task_count: 1,
      mission_count: 1,
      duplicate_submissions: 1,
      no_change_collapsed: 1,
    },
  };
  const receipt = publicBridgeReceipt({
    taskId: "ai109-private-bridge-canary",
    privateResult,
    persistence: { state: "EXISTING_VERIFIED" },
  });
  assert.equal(receipt.private_payload_exposed, false);
  assert.equal(receipt.private_stdout_exposed, false);
  assert.equal(receipt.private_stderr_exposed, false);
  assert.equal(receipt.credential_persisted, false);
  assert.equal(receipt.gpt_required, false);
  assert.equal(receipt.live_source_watcher_proven, false);
  assert.equal(receipt.persistence_state, "EXISTING_VERIFIED");
  const rendered = renderPublicBridgeReceipt(receipt);
  assert.ok(rendered.length < 1200);
  for (const forbidden of ["PRIVATE-SECRET", "ghs_", "source_delta_external_runtime_canary.py"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
  assert.match(rendered, /"private_payload_exposed":false/);
  assert.match(rendered, /"private_stdout_exposed":false/);
  assert.match(rendered, /"private_stderr_exposed":false/);
});
