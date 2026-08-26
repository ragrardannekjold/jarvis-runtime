import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  gitBlobSha1,
  loadSnapshot,
  validateAttestation,
  validateSnapshot,
} from "./validate_token_cutover.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function fresh() {
  const { workflows, contract, manifest } = await loadSnapshot(ROOT);
  return {
    workflows: new Map(workflows),
    contract: structuredClone(contract),
    manifest: structuredClone(manifest),
  };
}

function repin(snapshot, workflowPath) {
  snapshot.contract.workflow_pins[workflowPath].git_blob_sha1 = gitBlobSha1(
    snapshot.workflows.get(workflowPath),
  );
}

function repinSource(snapshot, sourcePath) {
  snapshot.contract.privileged_source_pins[sourcePath] = gitBlobSha1(
    snapshot.workflows.get(sourcePath),
  );
}

test("CONTAIN baseline is exact and fail closed", async () => {
  const snapshot = await fresh();
  const result = validateSnapshot(snapshot.workflows, snapshot.contract);
  assert.deepEqual(result, {
    status: "PASS",
    phase: "CONTAIN",
    legacy_secret_bindings: 7,
    legacy_secret_workflows: 2,
    manual_tombstones: 6,
    privileged_source_pins: 25,
    historical_rerun_capability: "PENDING_NEUTRALIZATION",
    external_attestation: "PENDING_EXTERNAL_AUTHORITY",
  });
});

test("manual tombstone rejects a second job", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/repair-checkpoint-parser.yml";
  snapshot.workflows.set(
    workflowPath,
    `${snapshot.workflows.get(workflowPath)}  active-job:\n    runs-on: ubuntu-latest\n`,
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /manual tombstone identity changed/,
  );
});

test("manual tombstone rejects if true hidden by a false comment", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/command-center-runtime.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows
      .get(workflowPath)
      .replace("if: ${{ false }}", "# if: ${{ false }}\n    if: ${{ true }}"),
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /manual tombstone identity changed/,
  );
});

test("AI39 shared-token canary remains an exact quarantined lane", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/ai39-cdse-stac-canary.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace("if: ${{ false }}", "if: ${{ true }}"),
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /manual tombstone identity changed/,
  );
});

test("legacy secret cannot move to a new workflow or alias", async () => {
  const snapshot = await fresh();
  snapshot.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\njobs:\n  x:\n    env:\n      BRIDGE_KEY: ${{ secrets.COMMAND_CENTER_TOKEN }}\n",
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /legacy secret added to unapproved workflow|workflow secret is not allowlisted/,
  );
});

for (const secretExpression of [
  "secrets['COMMAND_CENTER_TOKEN']",
  'secrets["command_center_token"]',
  "secrets[env.SECRET_NAME]",
]) {
  test(`dynamic or bracket secret bypass is rejected: ${secretExpression}`, async () => {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\njobs:\n  x:\n    env:\n      TOKEN: \${{ ${secretExpression} }}\n`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /dynamic or bracket secret lookup forbidden/,
    );
  });
}

test("whole or inherited secret context cannot bypass named references", async () => {
  const snapshot = await fresh();
  snapshot.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    env:\n      ALL_SECRETS: ${{ toJSON(secrets) }}\n    steps:\n      - run: echo blocked\n",
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /whole or computed secret context forbidden/,
  );

  snapshot.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    env:\n      ALL_SECRETS: ${{ secrets }}\n",
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /whole or computed secret context forbidden/,
  );

  for (const inheritLine of [
    "secrets: inherit",
    'secrets: "inherit"',
    '"secrets": inherit',
    "'secrets': 'inherit'",
    "secrets: >-\n      inherit",
    "secrets: |\n      inherit",
    "secrets: *all_secrets",
    '"sec\\u0072ets": inherit',
  ]) {
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\njobs:\n  x:\n    uses: o/r/.github/workflows/x.yml@main\n    ${inheritLine}\n`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /secret delegation mapping forbidden|YAML tags, anchors, and aliases are unsupported|escaped double-quoted YAML scalars are unsupported/,
    );
  }
});

test("non-canonical YAML cannot conceal secret delegation", async () => {
  const variants = [
    '"sec\\x72ets": inherit',
    '"sec\\U00000072ets": inherit',
    "!!str secrets: inherit",
    "&secret_key secrets: inherit",
    "? secrets\n    : inherit",
    "*secret_key: inherit",
  ];
  for (const variant of variants) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\njobs:\n  x:\n    uses: o/r/.github/workflows/x.yml@main\n    ${variant}\n`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /unsupported YAML|multiline scalar values are unsupported|YAML mapping keys are unsupported|YAML tags, anchors, and aliases are unsupported|escaped double-quoted YAML scalars are unsupported/,
      variant,
    );
  }

  const anchoredAlias = await fresh();
  anchoredAlias.workflows.set(
    ".github/workflows/injected.yml",
    "name: &secret_key secrets\non:\n  workflow_dispatch:\njobs:\n  x:\n    uses: o/r/.github/workflows/x.yml@main\n    *secret_key: inherit\n",
  );
  assert.throws(
    () => validateSnapshot(anchoredAlias.workflows, anchoredAlias.contract),
    /YAML tags, anchors, and aliases are unsupported/,
  );

  const flowMapping = await fresh();
  flowMapping.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\njobs: {x: {uses: o/r/.github/workflows/x.yml@main, secrets: inherit}}\n",
  );
  assert.throws(
    () => validateSnapshot(flowMapping.workflows, flowMapping.contract),
    /flow mappings are unsupported/,
  );

  for (const encodedExpression of [
    '"${{ \\u0073ecrets.COMMAND_CENTER_\\u0054OKEN }}"',
    '"${{ \\x73ecrets }}"',
    '"${{ \\u0073ecrets }}"',
    '"${{ sec\\\n      rets }}"',
  ]) {
    const encodedScalar = await fresh();
    encodedScalar.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    env:\n      TOKEN: ${encodedExpression}\n`,
    );
    assert.throws(
      () => validateSnapshot(encodedScalar.workflows, encodedScalar.contract),
      /escaped double-quoted YAML scalars are unsupported|multiline or unsupported double-quoted YAML scalar/,
      encodedExpression,
    );
  }

  for (const encodedSequence of [
    'branches:\n      - "${{ \\u0073ecrets.DEPLOY_PAT }}"',
    'branches: ["${{ \\u0073ecrets.DEPLOY_PAT }}"]',
  ]) {
    const sequenceScalar = await fresh();
    sequenceScalar.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  push:\n    ${encodedSequence}\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo blocked\n`,
    );
    assert.throws(
      () => validateSnapshot(sequenceScalar.workflows, sequenceScalar.contract),
      /escaped double-quoted YAML scalars are unsupported/,
      encodedSequence,
    );
  }

  for (const nonCanonicalFlow of [
    "types: [&event opened, *event]",
    "types: [!!str opened]",
    "types: [{secrets: inherit}]",
  ]) {
    const flowSequence = await fresh();
    flowSequence.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  issues:\n    ${nonCanonicalFlow}\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo blocked\n`,
    );
    assert.throws(
      () => validateSnapshot(flowSequence.workflows, flowSequence.contract),
      /non-canonical flow sequence is unsupported/,
      nonCanonicalFlow,
    );
  }
});

test("non-canonical YAML cannot conceal write authority", async () => {
  for (const permissions of [
    'permissions:\n  "cont\\x65nts": write',
    "permissions: {contents: write}",
    "permissions:\n  contents: read\n  contents: write",
    'permissions:\n  actions: "wr\\x69te"',
    "permissions:\n  id-token: >-\n    write",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\n${permissions}\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo blocked\n`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /unsupported YAML|flow mappings are unsupported|duplicate YAML mapping key|permission value must be a canonical|escaped double-quoted YAML scalars are unsupported|multiline or unsupported double-quoted YAML scalar/,
      permissions,
    );
  }
});

test("every workflow requires an explicit top-level permissions boundary", async () => {
  const snapshot = await fresh();
  snapshot.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  pull_request_target:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    env:\n      GH_TOKEN: ${{ github.token }}\n    steps:\n      - run: echo blocked\n",
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /workflow must declare exactly one explicit top-level permissions policy/,
  );
});

test("broad read-all permissions are rejected", async () => {
  const snapshot = await fresh();
  snapshot.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\npermissions: read-all\njobs:\n  x:\n    runs-on: ubuntu-latest\n    env:\n      GH_TOKEN: ${{ github.token }}\n    steps:\n      - run: echo blocked\n",
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /broad workflow permissions forbidden/,
  );
});

test("blank or sequence-shaped permissions cannot inherit hidden authority", async () => {
  for (const permissions of [
    "permissions:",
    "permissions:\n  - write-all",
    "permissions:\n  - contents: write",
    "permissions:\n  contents: read\n  - write-all",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected
on:
  workflow_dispatch:
${permissions}
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo blocked
`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /permissions must be a non-empty canonical mapping or \{\}|permissions block sequences are unsupported/,
      permissions,
    );
  }
});

test("current and unknown permission capabilities fail closed", async () => {
  for (const capability of ["artifact-metadata", "code-quality", "vulnerability-alerts"]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\npermissions:\n  contents: read\n  ${capability}: write\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo blocked\n`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /write permission scope is not allowlisted/,
      capability,
    );
  }

  for (const capability of ["actions", "security-events"]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\npermissions:\n  contents: read\n  ${capability}: read\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: attacker/action@v1\n`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /read permission scope is not allowlisted/,
      capability,
    );
  }

  const unknown = await fresh();
  unknown.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\npermissions:\n  contents: read\n  future-capability: read\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo blocked\n",
  );
  assert.throws(
    () => validateSnapshot(unknown.workflows, unknown.contract),
    /unknown GitHub permission key/,
  );
});

test("secret or write workflows reject mutable external action references", async () => {
  for (const [workflowPath, exactReference, mutableReference] of [
    [
      ".github/workflows/shodan-runtime-readback.yml",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v4",
    ],
    [
      ".github/workflows/async-job-worker.yml",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/setup-node@v4",
    ],
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      workflowPath,
      snapshot.workflows.get(workflowPath).replace(exactReference, mutableReference),
    );
    repin(snapshot, workflowPath);
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /external executable reference must use a full commit SHA|reviewed Node 24 (?:target and action runtime|runtime pin)/,
      workflowPath,
    );
  }
});

test("privileged workflows reject local actions and persisted checkout credentials", async () => {
  const workflowPath = ".github/workflows/shodan-runtime-readback.yml";
  const localAction = await fresh();
  localAction.workflows.set(
    workflowPath,
    localAction.workflows.get(workflowPath).replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "./.github/actions/local-prep",
    ),
  );
  repin(localAction, workflowPath);
  assert.throws(
    () => validateSnapshot(localAction.workflows, localAction.contract),
    /local executable action references are forbidden in privileged workflows/,
  );

  const persistedCredential = await fresh();
  persistedCredential.workflows.set(
    workflowPath,
    persistedCredential.workflows.get(workflowPath).replace(
      "        with:\n          persist-credentials: false\n",
      "",
    ),
  );
  repin(persistedCredential, workflowPath);
  assert.throws(
    () => validateSnapshot(persistedCredential.workflows, persistedCredential.contract),
    /privileged checkout must disable persisted credentials/,
  );
});

test("privileged workflow run closures reject added local executables after repinning", async () => {
  const shodanPath = ".github/workflows/shodan-runtime-readback.yml";
  const shodan = await fresh();
  shodan.workflows.set(
    shodanPath,
    shodan.workflows.get(shodanPath).replace(
      "          python -I -S runtime/shodan_readback.py",
      "          python runtime/generate_daily_main_report.py\n          python -I -S runtime/shodan_readback.py",
    ),
  );
  repin(shodan, shodanPath);
  assert.throws(
    () => validateSnapshot(shodan.workflows, shodan.contract),
    /Shodan workflow execution closure must be the exact pinned credential-reader step/,
  );

  const unisolatedShodan = await fresh();
  unisolatedShodan.workflows.set(
    shodanPath,
    unisolatedShodan.workflows.get(shodanPath).replace(
      "python -I -S runtime/shodan_readback.py",
      "python runtime/shodan_readback.py",
    ),
  );
  repin(unisolatedShodan, shodanPath);
  assert.throws(
    () => validateSnapshot(unisolatedShodan.workflows, unisolatedShodan.contract),
    /Shodan workflow execution closure must be the exact pinned credential-reader step/,
  );

  const asyncPath = ".github/workflows/async-job-worker.yml";
  const asyncJob = await fresh();
  asyncJob.workflows.set(
    asyncPath,
    asyncJob.workflows.get(asyncPath).replace(
      "run: node runtime/async-jobs/worker.mjs",
      "run: node runtime/async-jobs/worker.mjs && node runtime/investigation_passive_index.mjs",
    ),
  );
  repin(asyncJob, asyncPath);
  assert.throws(
    () => validateSnapshot(asyncJob.workflows, asyncJob.contract),
    /Async workflow execution closure must contain only its exact pinned issue worker command/,
  );
});

test("continuous queue keeps minimum authority and a fixed tokenless execution closure", async () => {
  const workflowPath = ".github/workflows/continuous-external-queue.yml";

  const actionsWrite = await fresh();
  actionsWrite.workflows.set(
    workflowPath,
    actionsWrite.workflows.get(workflowPath).replace(
      "  contents: read\n  issues: write",
      "  contents: read\n  issues: write\n  actions: write",
    ),
  );
  repin(actionsWrite, workflowPath);
  assert.throws(
    () => validateSnapshot(actionsWrite.workflows, actionsWrite.contract),
    /write permission scope is not allowlisted/,
  );

  const manualRef = await fresh();
  manualRef.workflows.set(
    workflowPath,
    manualRef.workflows.get(workflowPath).replace(
      "  schedule:\n",
      "  workflow_dispatch:\n  schedule:\n",
    ),
  );
  repin(manualRef, workflowPath);
  assert.throws(
    () => validateSnapshot(manualRef.workflows, manualRef.contract),
    /must rely only on owner issue events and the five-minute schedule|fixed local execution (?:pin|blob) drifted/,
  );

  const sourcePath = "runtime/continuous-queue/worker.mjs";
  const inheritedToken = await fresh();
  inheritedToken.workflows.set(
    sourcePath,
    inheritedToken.workflows.get(sourcePath).replace(
      "env: TOKENLESS_CHILD_ENV",
      "env: process.env",
    ),
  );
  repinSource(inheritedToken, sourcePath);
  assert.throws(
    () => validateSnapshot(inheritedToken.workflows, inheritedToken.contract),
    /child execution must use exact tokenless Node invocations|fixed local execution (?:pin|blob) drifted/,
  );

  const packageManager = await fresh();
  packageManager.workflows.set(
    sourcePath,
    packageManager.workflows.get(sourcePath).replace(
      "const TOKENLESS_CHILD_ENV = Object.freeze({});",
      "const TOKENLESS_CHILD_ENV = Object.freeze({});\n// npm utility_search_self_test",
    ),
  );
  repinSource(packageManager, sourcePath);
  assert.throws(
    () => validateSnapshot(packageManager.workflows, packageManager.contract),
    /cannot install packages or self-dispatch|fixed local execution (?:pin|blob) drifted/,
  );
});

test("issues-write workers cannot regress to the EOL Node 20 target", async () => {
  for (const workflowPath of [
    ".github/workflows/async-job-worker.yml",
    ".github/workflows/continuous-external-queue.yml",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      workflowPath,
      snapshot.workflows.get(workflowPath).replace("node-version: '24'", "node-version: '20'"),
    );
    repin(snapshot, workflowPath);
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /reviewed Node 24 target and action runtime|setup-node must select the Node 24 target|fixed local execution (?:pin|blob) drifted/,
      workflowPath,
    );
  }
});

test("privileged and guard workflows reject pre-Node24 action runtimes after repinning", async () => {
  for (const [workflowPath, reviewedReference, oldRuntimeReference] of [
    [
      ".github/workflows/async-job-worker.yml",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    ],
    [
      ".github/workflows/shodan-runtime-readback.yml",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    ],
    [
      ".github/workflows/kyiv-fast-watch.yml",
      "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
      "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065",
    ],
    [
      ".github/workflows/token-cutover-guard-ci.yml",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    ],
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      workflowPath,
      snapshot.workflows.get(workflowPath).replace(reviewedReference, oldRuntimeReference),
    );
    if (snapshot.contract.workflow_pins[workflowPath]) repin(snapshot, workflowPath);
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /reviewed Node 24 (?:target and action runtime|runtime pin)|official action must use the reviewed Node 24 runtime pin|guard must use only the reviewed Node 24 action runtime closure/,
      workflowPath,
    );
  }
});

test("setup-node automatic package-manager cache cannot be re-enabled", async () => {
  for (const workflowPath of [
    ".github/workflows/async-job-worker.yml",
    ".github/workflows/token-cutover-guard-ci.yml",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      workflowPath,
      snapshot.workflows.get(workflowPath).replace("package-manager-cache: false", "package-manager-cache: true"),
    );
    if (snapshot.contract.workflow_pins[workflowPath]) repin(snapshot, workflowPath);
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /reviewed Node 24 target and action runtime|automatic package-manager cache must be disabled/,
      workflowPath,
    );
  }
});

test("inline sequence block scalars cannot hide privileged step siblings", async () => {
  const guardPath = ".github/workflows/token-cutover-guard-ci.yml";
  const hiddenAction = await fresh();
  hiddenAction.workflows.set(
    guardPath,
    `${hiddenAction.workflows.get(guardPath)}
      - name: |
          Hidden external action
        uses: attacker/action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`,
  );
  assert.throws(
    () => validateSnapshot(hiddenAction.workflows, hiddenAction.contract),
    /token cutover guard must use only the reviewed Node 24 action runtime closure|token cutover guard workflow exact blob drifted/,
  );

  const shodanPath = ".github/workflows/shodan-runtime-readback.yml";
  const hiddenCredentialPersistence = await fresh();
  hiddenCredentialPersistence.workflows.set(
    shodanPath,
    hiddenCredentialPersistence.workflows.get(shodanPath).replace(
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false",
      "      - name: |\n          Hidden checkout credential persistence\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: true",
    ),
  );
  repin(hiddenCredentialPersistence, shodanPath);
  assert.throws(
    () => validateSnapshot(hiddenCredentialPersistence.workflows, hiddenCredentialPersistence.contract),
    /privileged checkout must disable persisted credentials/,
  );

  const asyncPath = ".github/workflows/async-job-worker.yml";
  const hiddenCache = await fresh();
  hiddenCache.workflows.set(
    asyncPath,
    `${hiddenCache.workflows.get(asyncPath)}
      - name: |
          Hidden automatic package cache
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: '24'
          package-manager-cache: true
`,
  );
  repin(hiddenCache, asyncPath);
  assert.throws(
    () => validateSnapshot(hiddenCache.workflows, hiddenCache.contract),
    /setup-node automatic package-manager cache must be disabled/,
  );
});

test("token cutover guard workflow is exact-byte closed", async () => {
  const workflowPath = ".github/workflows/token-cutover-guard-ci.yml";
  for (const mutate of [
    (workflow) => `${workflow}\n      - name: Rewrite checked-out inputs\n        run: echo mutation\n`,
    (workflow) => workflow.replace("  verify:\n", "  verify:\n    if: ${{ false }}\n"),
    (workflow) => workflow.replace("    runs-on: ubuntu-latest", "    env:\n      NODE_OPTIONS: --require=./mutation.cjs\n    runs-on: ubuntu-latest"),
    (workflow) => workflow.replace(
      "      - name: Validate current token-cutover state\n        run: node runtime/security/validate_token_cutover.mjs --root .\n\n",
      "",
    ),
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(workflowPath, mutate(snapshot.workflows.get(workflowPath)));
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /token cutover guard workflow exact blob drifted|token cutover guard verification closure drifted/,
    );
  }
});

test("knowledge/skill bus remains a read-only Node24 canary outside the public issue queue", async () => {
  const workflowPath = ".github/workflows/knowledge-skill-bus-ci.yml";
  const oldRuntime = await fresh();
  oldRuntime.workflows.set(
    workflowPath,
    oldRuntime.workflows.get(workflowPath).replace(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    ),
  );
  assert.throws(
    () => validateSnapshot(oldRuntime.workflows, oldRuntime.contract),
    /fixed read-only knowledge\/skill bus blob drifted|official action must use the reviewed Node 24 runtime pin|bus CI must use only the reviewed Node 24 action runtime closure/,
  );

  const publicRoute = await fresh();
  const workerPath = "runtime/continuous-queue/worker.mjs";
  publicRoute.workflows.set(
    workerPath,
    publicRoute.workflows.get(workerPath).replace(
      '  "heartbeat_probe",',
      '  "heartbeat_probe",\n  "bus_packet_validate",',
    ),
  );
  repinSource(publicRoute, workerPath);
  assert.throws(
    () => validateSnapshot(publicRoute.workflows, publicRoute.contract),
    /job-type allowlist drifted from the exact public set|scrapeable public queue must keep inline knowledge\/skill packets quarantined/,
  );

  const networkedCore = await fresh();
  const corePath = "runtime/knowledge-skill-bus/bus-core.mjs";
  networkedCore.workflows.set(
    corePath,
    networkedCore.workflows.get(corePath).replace(
      'import { createHash } from "node:crypto";',
      'import { createHash } from "node:crypto";\nfetch("https://example.invalid");',
    ),
  );
  assert.throws(
    () => validateSnapshot(networkedCore.workflows, networkedCore.contract),
    /fixed read-only knowledge\/skill bus blob drifted|contract must remain a pure non-network validator/,
  );
});

test("read-only knowledge/skill bus execution closure is exact-byte pinned", async () => {
  for (const [sourcePath, mutate] of [
    [
      ".github/workflows/knowledge-skill-bus-ci.yml",
      (source) => source.replace(
        "run: node runtime/knowledge-skill-bus/canary.mjs",
        "run: node runtime/knowledge-skill-bus/canary.mjs\n\n      - run: curl https://example.invalid",
      ),
    ],
    [
      "runtime/knowledge-skill-bus/bus-core.mjs",
      (source) => source.replace(
        'import { createHash } from "node:crypto";',
        'import { createHash } from "node:crypto";\nglobalThis["fetch"]("https://example.invalid");',
      ),
    ],
    [
      "runtime/knowledge-skill-bus/bus-core.test.mjs",
      (source) => `${source}\nprocess.getBuiltinModule("node:" + "child_process").execFileSync("curl", ["https://example.invalid"]);\n`,
    ],
    [
      "runtime/knowledge-skill-bus/canary.mjs",
      (source) => `${source}\nglobalThis["fetch"]("https://example.invalid");\n`,
    ],
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(sourcePath, mutate(snapshot.workflows.get(sourcePath)));
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /fixed read-only knowledge\/skill bus blob drifted/,
      sourcePath,
    );
  }
});

test("alternate issue-triggered workflow cannot reopen a scrapeable bus route", async () => {
  const snapshot = await fresh();
  snapshot.workflows.set(
    ".github/workflows/alternate-bus-route.yml",
    `name: alternate bus route
on:
    issues:
      types: [opened]
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: '24'
          package-manager-cache: false
      - run: node -e 'import("./runtime/knowledge"+"-skill-bus/bus"+"-core.mjs")'
`,
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /scrapeable public-content trigger is not allowlisted|knowledge\/skill bus executable reference escaped its exact CI closure/,
  );
});

test("other scrapeable public-content triggers cannot reopen an alternate bus route", async () => {
  for (const trigger of [
    "issue_comment",
    "discussion",
    "discussion_comment",
    "pull_request_target",
    "pull_request_review",
    "pull_request_review_comment",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      `.github/workflows/${trigger.replaceAll("_", "-")}-bus-route.yml`,
      `name: alternate public content route
on:
  ${trigger}:
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - run: node -e 'import("./runtime/knowledge"+"-skill-bus/bus"+"-core.mjs")'
`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /scrapeable public-content trigger is not allowlisted/,
      trigger,
    );
  }
});

test("block-sequence triggers cannot hide an alternate scrapeable bus route", async () => {
  for (const triggerBlock of [
    "on:\n  - issues",
    'on:\n    - "issues"',
    "on:\n- 'issues'",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/block-sequence-bus-route.yml",
      `name: block sequence bus route
${triggerBlock}
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - run: node -e 'import("./runtime/knowledge"+"-skill-bus/bus"+"-core.mjs")'
`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /on block sequences are unsupported; use a mapping/,
      triggerBlock,
    );
  }
});

test("multiline scalar triggers cannot hide an alternate scrapeable bus route", async () => {
  for (const triggerBlock of [
    "on:\n  issues",
    "on:\n    'issues'",
    'on:\n  "issues"',
    "on:\nissues",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/multiline-scalar-bus-route.yml",
      `name: multiline scalar bus route
${triggerBlock}
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - run: node -e 'import("./runtime/knowledge"+"-skill-bus/bus"+"-core.mjs")'
`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /multiline scalar values are unsupported/,
      triggerBlock,
    );
  }
});

test("multiline broad permissions cannot bypass the authority boundary", async () => {
  for (const permissionsBlock of [
    "permissions:\n  write-all",
    "permissions:\n    read-all",
    "permissions:\n  'write-all'",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/multiline-scalar-permissions.yml",
      `name: multiline scalar permissions
on:
  workflow_dispatch:
${permissionsBlock}
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - run: echo contained
`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /multiline scalar values are unsupported/,
      permissionsBlock,
    );
  }
});

test("public manifest cannot claim that scrapeable bus transport is enabled", async () => {
  const snapshot = await fresh();
  snapshot.manifest.knowledge_skill_bus.enabled_job_type = "bus_packet_validate";
  snapshot.manifest.knowledge_skill_bus.public_issue_transport_enabled = true;
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract, snapshot.manifest),
    /knowledge\/skill bus quarantine boundary drifted/,
  );

  const attestation = await fresh();
  attestation.manifest.knowledge_skill_bus.historical_public_canary.security_attestation_accepted = true;
  assert.throws(
    () => validateSnapshot(attestation.workflows, attestation.contract, attestation.manifest),
    /knowledge\/skill bus quarantine boundary drifted/,
  );
});

test("async worker job-type allowlist is exact across YAML-style quote spellings", async () => {
  const snapshot = await fresh();
  const sourcePath = "runtime/async-jobs/contract.mjs";
  snapshot.workflows.set(
    sourcePath,
    snapshot.workflows.get(sourcePath).replace(
      '  "intentional_failure_probe",',
      '  "intentional_failure_probe",\n  \'utility_search_self_test\',',
    ),
  );
  repinSource(snapshot, sourcePath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /Async worker job-type allowlist drifted from the exact token-safe set|job-type allowlist semantics were mutated/,
  );
});

test("fixed local source pins reject behavioral overrides after contract repinning", async () => {
  const snapshot = await fresh();
  const sourcePath = "runtime/async-jobs/contract.mjs";
  snapshot.workflows.set(
    sourcePath,
    snapshot.workflows.get(sourcePath).replace(
      "const CANONICAL_ID_RE =",
      "Set.prototype.has = () => true;\n\nconst CANONICAL_ID_RE =",
    ),
  );
  repinSource(snapshot, sourcePath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /fixed local execution (?:pin|blob) drifted/,
  );
});

test("complete privileged closure rejects legacy-lane repin bypasses", async () => {
  const workflowPath = ".github/workflows/exposure-intelligence.yml";

  const container = await fresh();
  container.workflows.set(
    workflowPath,
    container.workflows.get(workflowPath).replace(
      "    runs-on: ubuntu-latest",
      "    runs-on: ubuntu-latest\n    container: attacker/image:latest",
    ),
  );
  repin(container, workflowPath);
  assert.throws(
    () => validateSnapshot(container.workflows, container.contract),
    /cannot use job containers or services|fixed local execution (?:pin|blob) drifted/,
  );

  const selfHosted = await fresh();
  selfHosted.workflows.set(
    workflowPath,
    selfHosted.workflows.get(workflowPath).replace(
      "runs-on: ubuntu-latest",
      "runs-on: self-hosted",
    ),
  );
  repin(selfHosted, workflowPath);
  assert.throws(
    () => validateSnapshot(selfHosted.workflows, selfHosted.contract),
    /must use the exact GitHub-hosted runner|fixed local execution (?:pin|blob) drifted/,
  );

  const relocatedSecret = await fresh();
  relocatedSecret.workflows.set(
    workflowPath,
    relocatedSecret.workflows.get(workflowPath)
      .replace(
        "  passive-read:\n    needs:",
        "  passive-read:\n    env:\n      COMMAND_CENTER_TOKEN: ${{ secrets.COMMAND_CENTER_TOKEN }}\n    needs:",
      )
      .replace(
        "          COMMAND_CENTER_TOKEN: ${{ secrets.COMMAND_CENTER_TOKEN }}",
        "          COMMAND_CENTER_TOKEN: inherited",
      ),
  );
  repin(relocatedSecret, workflowPath);
  assert.throws(
    () => validateSnapshot(relocatedSecret.workflows, relocatedSecret.contract),
    /fixed local execution (?:pin|blob) drifted/,
  );

  const sourcePath = "runtime/exposure_queue_worker.mjs";
  const sourceOverride = await fresh();
  sourceOverride.workflows.set(
    sourcePath,
    `process.env.COMMAND_CENTER_TOKEN && console.log(process.env.COMMAND_CENTER_TOKEN);\n${sourceOverride.workflows.get(sourcePath)}`,
  );
  repinSource(sourceOverride, sourcePath);
  assert.throws(
    () => validateSnapshot(sourceOverride.workflows, sourceOverride.contract),
    /fixed local execution (?:pin|blob) drifted/,
  );
});

test("Kyiv cannot restore selected-ref dispatch or self-dispatch after repinning", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/kyiv-fast-watch.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows
      .get(workflowPath)
      .replace(
        "on:\n  schedule:\n",
        "on:\n  workflow_dispatch:\n  schedule:\n",
      ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /schedule-only|fixed local execution (?:pin|blob) drifted/,
  );
});

test("every secret-bearing lane rejects manual selected-ref execution", async () => {
  for (const workflowPath of [
    ".github/workflows/kyiv-fast-watch.yml",
    ".github/workflows/exposure-intelligence.yml",
    ".github/workflows/kyiv-cdse-event-queue.yml",
    ".github/workflows/shodan-runtime-readback.yml",
  ]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      workflowPath,
      snapshot.workflows.get(workflowPath).replace(
        "on:\n  schedule:\n",
        "on:\n  workflow_dispatch:\n  schedule:\n",
      ),
    );
    repin(snapshot, workflowPath);
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /schedule-only|fixed local execution (?:pin|blob) drifted/,
      workflowPath,
    );
  }
});

test("Kyiv keeps degraded readback but cannot track mutable private main", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/kyiv-fast-watch.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      "if: ${{ !cancelled() && steps.fast_watch_tests.outcome == 'success' }}",
      "if: success()",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /degraded readback|fixed local execution (?:pin|blob) drifted/,
  );

  const privateSnapshot = await fresh();
  privateSnapshot.workflows.set(
    workflowPath,
    privateSnapshot.workflows.get(workflowPath).replace(
      "ref: b2588be4b7391a40175ab8ca808594f6fb8dc464",
      "ref: main",
    ),
  );
  repin(privateSnapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(privateSnapshot.workflows, privateSnapshot.contract),
    /exact reviewed commit|mutable main|fixed local execution (?:pin|blob) drifted/,
  );
});

test("Exposure cannot bypass failed boundary tests even after repinning", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/exposure-intelligence.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows
      .get(workflowPath)
      .replace(
        "if: ${{ !cancelled() && github.event_name == 'schedule' && needs.boundary-tests.result == 'success' }}",
        "if: always()",
      ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /isolated boundary-test job|may not bypass failed tests|fixed local execution (?:pin|blob) drifted/,
  );
});

test("Investigation cannot bypass privileged checkout or runtime setup failure", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/exposure-intelligence.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      " && steps.runtime_node.outcome == 'success'",
      "",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /successful privileged checkout and runtime setup|fixed local execution (?:pin|blob) drifted/,
  );
});

test("secret-bearing Exposure push trigger is rejected after repinning", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/exposure-intelligence.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      "  schedule:\n",
      "  push:\n    branches: [main]\n  schedule:\n",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /Exposure secret-bearing trigger|fixed local execution (?:pin|blob) drifted/,
  );
});

test("credential persistence cannot be re-enabled after repinning", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/exposure-intelligence.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      "persist-credentials: false",
      "persist-credentials: true",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /must not persist credentials|privileged checkout must disable persisted credentials/,
  );
});

test("a provider secret cannot move into an unpinned write path", async () => {
  const snapshot = await fresh();
  snapshot.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  x:\n    env:\n      TOKEN: ${{ secrets.SHODAN_API_KEY }}\n    steps:\n      - run: |\n          \"git\" \"push\" origin HEAD:main\n",
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /workflow secret is not allowlisted/,
  );
});

test("exact secret and permission authority neutralize shell spelling variants", async () => {
  const snapshot = await fresh();
  snapshot.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  x:\n    runs-on: ubuntu-latest\n    env:\n      DEPLOY_PAT: ${{ secrets.DEPLOY_PAT }}\n    steps:\n      - run: |\n          git push origin \\\n            HEAD:main\n",
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /workflow secret is not allowlisted/,
  );

  snapshot.workflows.set(
    ".github/workflows/injected.yml",
    "name: injected\non:\n  workflow_dispatch:\npermissions:\n  contents: write\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo blocked\n",
  );
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /write permission scope is not allowlisted|contents permission must stay read-only/,
  );

  for (const shellCommand of [
    "git pu\\\nsh origin HEAD:main",
    "g\\\nit pu\\\nsh origin HEAD:main",
    '"git" "push" origin HEAD:main',
    "git -C . push origin HEAD:main",
    "git p''ush origin HEAD:main",
    'g=git; p=push; "$g" "$p" origin HEAD:main',
  ]) {
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  x:\n    env:\n      DEPLOY_PAT: \${{ secrets.DEPLOY_PAT }}\n    steps:\n      - run: |\n          ${shellCommand.replaceAll("\n", "\n          ")}\n`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /workflow secret is not allowlisted/,
      shellCommand,
    );
  }
});

test("untrusted workflow cannot obtain any write authority", async () => {
  for (const capability of ["actions", "issues"]) {
    const snapshot = await fresh();
    snapshot.workflows.set(
      ".github/workflows/injected.yml",
      `name: injected\non:\n  workflow_dispatch:\npermissions:\n  contents: read\n  ${capability}: write\njobs:\n  x:\n    steps:\n      - run: echo blocked\n`,
    );
    assert.throws(
      () => validateSnapshot(snapshot.workflows, snapshot.contract),
      /write permission scope is not allowlisted/,
      capability,
    );
  }
});

test("issues write cannot move from its pinned top-level scope", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/async-job-worker.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      "  run-public-job:\n    if:",
      "  run-public-job:\n    permissions:\n      contents: read\n      issues: write\n    if:",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /write permission scope is not allowlisted.*jobs\/run-public-job\/permissions.*issues/,
  );
});

test("CDSE cannot lose required collector-dispatch authority", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/kyiv-cdse-event-queue.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      "\n      actions: write",
      "",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /collector dispatch authority must exist only on the drain job|fixed local execution (?:pin|blob) drifted/,
  );
});

test("CDSE validation stays read-only even after workflow repinning", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/kyiv-cdse-event-queue.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      "permissions:\n  contents: read",
      "permissions:\n  contents: read\n  actions: write",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /top-level permissions must stay read-only|write permission scope is not allowlisted/,
  );
});

test("CDSE Actions write cannot move from drain into validation", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/kyiv-cdse-event-queue.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      "  validate:\n    runs-on: ubuntu-latest",
      "  validate:\n    permissions:\n      contents: read\n      \"actions\": \"write\"\n    runs-on: ubuntu-latest",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /write permission scope is not allowlisted.*jobs\/validate\/permissions.*actions/,
  );
});

test("CDSE drain retains its bounded five-minute runtime budget", async () => {
  const snapshot = await fresh();
  const workflowPath = ".github/workflows/kyiv-cdse-event-queue.yml";
  snapshot.workflows.set(
    workflowPath,
    snapshot.workflows.get(workflowPath).replace(
      "      actions: write\n    runs-on: ubuntu-latest\n    timeout-minutes: 5",
      "      actions: write\n    runs-on: ubuntu-latest\n    timeout-minutes: 1",
    ),
  );
  repin(snapshot, workflowPath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /five-minute runtime budget|fixed local execution (?:pin|blob) drifted/,
  );
});

test("CDSE source cannot repoint dispatch after source repinning", async () => {
  const snapshot = await fresh();
  const sourcePath = "runtime/kyiv-v3/cdse_event_queue.py";
  snapshot.workflows.set(
    sourcePath,
    snapshot.workflows.get(sourcePath).replace(
      'WORKFLOW = "kyiv-v3-public-collector.yml"',
      'WORKFLOW = "kyiv-fast-watch.yml"',
    ),
  );
  repinSource(snapshot, sourcePath);
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /dispatch target must stay the public collector|fixed local execution (?:pin|blob) drifted/,
  );
});

test("one replacement secret name cannot own two lanes", async () => {
  const snapshot = await fresh();
  snapshot.contract.critical_lanes[2].replacement_secret_names = [
    "EXPOSURE_QUEUE_RW_TOKEN",
  ];
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /replacement secret reused by two lanes/,
  );
});

test("cutover phase cannot be downgraded", async () => {
  const snapshot = await fresh();
  snapshot.contract.phase = "RATCHET";
  assert.throws(
    () => validateSnapshot(snapshot.workflows, snapshot.contract),
    /phase downgrade forbidden/,
  );
});

test("public manifest cannot claim a disabled schedule", async () => {
  const snapshot = await fresh();
  snapshot.manifest.command_center_runtime_schedule_enabled = true;
  assert.throws(
    () => validateSnapshot(
      snapshot.workflows,
      snapshot.contract,
      snapshot.manifest,
    ),
    /disabled command runtime cannot claim a schedule/,
  );
});

test("public manifest cannot claim repository-secret isolation", async () => {
  const snapshot = await fresh();
  snapshot.manifest.token_cutover.repository_secret_registry_isolation = "VERIFIED";
  assert.throws(
    () => validateSnapshot(
      snapshot.workflows,
      snapshot.contract,
      snapshot.manifest,
    ),
    /overclaims repository-secret isolation/,
  );
});

test("ENFORCED fails closed without external secret and revocation attestation", async () => {
  const snapshot = await fresh();
  snapshot.contract.phase = "ENFORCED";
  assert.throws(
    () => validateAttestation(snapshot.contract),
    /requires verified external attestation/,
  );
});
