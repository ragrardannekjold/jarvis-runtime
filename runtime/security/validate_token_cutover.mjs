#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CONTRACT_PATH = "runtime/security/token_cutover_contract.json";
export const MANIFEST_PATH = "PUBLIC_EXPORT_MANIFEST.json";
export const EXPECTED_CONTRACT_SHA256 =
  "695e5148d94b2705a2c4818a998ab764ebf68783cf963861d64496622bbe36ee";
const CONTAIN_PHASE_INDEX = 2;
const OFFICIAL_NODE24_ACTION_PINS = new Map([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/setup-python", "5fda3b95a4ea91299a34e894583c3862153e4b97"],
]);
const FIXED_READ_ONLY_KSB_BLOBS = new Map([
  [".github/workflows/knowledge-skill-bus-ci.yml", "983a3916274b6ba33697165e9f086ba6f54c42bb"],
  ["runtime/knowledge-skill-bus/bus-core.mjs", "7daef445b83afec13bb585dd2521abd313571aaf"],
  ["runtime/knowledge-skill-bus/bus-core.test.mjs", "705ebf4ecda1ee32748d30b6adcdc842d665f817"],
  ["runtime/knowledge-skill-bus/canary.mjs", "9e908c805163cdaa31b75b6751c858f7a24f9620"],
]);
const EXPECTED_GUARD_WORKFLOW_BLOB = "4c94795b74ee4417c5e60a4da6f1138f97e3a4ee";
const ISSUE_TRIGGER_WORKFLOW_ALLOWLIST = new Set([
  ".github/workflows/async-job-worker.yml",
  ".github/workflows/continuous-external-queue.yml",
  ".github/workflows/public-outsource-worker.yml",
]);
const SCRAPEABLE_PUBLIC_INPUT_TRIGGERS = new Set([
  "issues",
  "issue_comment",
  "discussion",
  "discussion_comment",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
]);
const READ_AUTHORITY_SCOPES = new Set([
  ".github/workflows/runtime-anomaly-sentinel.yml|jobs/observe/permissions|actions",
  ".github/workflows/runtime-anomaly-sentinel.yml|jobs/observe/permissions|issues",
]);
const WRITE_AUTHORITY_SCOPES = new Set([
  ".github/workflows/kyiv-fast-watch.yml|permissions|actions",
  ".github/workflows/kyiv-cdse-event-queue.yml|jobs/drain/permissions|actions",
  ".github/workflows/async-job-worker.yml|permissions|issues",
  ".github/workflows/continuous-external-queue.yml|permissions|issues",
  ".github/workflows/public-outsource-worker.yml|permissions|issues",
]);
const ASYNC_TOKEN_WORKER_JOB_TYPES = [
  "heartbeat_probe",
  "intentional_failure_probe",
  "checkpoint_recovery_probe",
];
const CONTINUOUS_TOKEN_WORKER_JOB_TYPES = [
  "heartbeat_probe",
  "async_contract_self_test",
  "runtime_syntax_self_test",
  "sustained_rhythm_verification",
];
const PUBLIC_OUTSOURCE_WORKFLOW_PATH = ".github/workflows/public-outsource-worker.yml";
const PUBLIC_OUTSOURCE_CI_WORKFLOW_PATH = ".github/workflows/public-outsource-worker-ci.yml";
const PUBLIC_OUTSOURCE_SOURCE_IMPORTS = new Map([
  ["public_outsource_worker/integration/github_action_entry.mjs", [
    "node:fs/promises",
    "../src/github_issue_run.mjs",
    "../src/runtime.mjs",
    "./github_api_client.mjs",
  ]],
  ["public_outsource_worker/integration/github_api_client.mjs", []],
  ["public_outsource_worker/src/adapters/bubo.mjs", [
    "../canonical.mjs",
    "../errors.mjs",
    "../security.mjs",
  ]],
  ["public_outsource_worker/src/adapters/cuckoo.mjs", [
    "../canonical.mjs",
    "../errors.mjs",
    "../security.mjs",
  ]],
  ["public_outsource_worker/src/canonical.mjs", ["node:crypto"]],
  ["public_outsource_worker/src/dispatcher.mjs", [
    "./canonical.mjs",
    "./errors.mjs",
    "./ledger.mjs",
    "./security.mjs",
  ]],
  ["public_outsource_worker/src/errors.mjs", []],
  ["public_outsource_worker/src/github_issue_coordinator.mjs", [
    "./canonical.mjs",
    "./errors.mjs",
    "./security.mjs",
  ]],
  ["public_outsource_worker/src/github_issue_run.mjs", [
    "./errors.mjs",
    "./github_issue_coordinator.mjs",
  ]],
  ["public_outsource_worker/src/ledger.mjs", [
    "node:crypto",
    "./canonical.mjs",
    "./errors.mjs",
  ]],
  ["public_outsource_worker/src/registry.mjs", ["./errors.mjs"]],
  ["public_outsource_worker/src/runtime.mjs", [
    "./adapters/bubo.mjs",
    "./adapters/cuckoo.mjs",
    "./dispatcher.mjs",
    "./registry.mjs",
  ]],
  ["public_outsource_worker/src/security.mjs", ["./errors.mjs"]],
]);
const PUBLIC_OUTSOURCE_EXPORT_PATHS = [
  PUBLIC_OUTSOURCE_WORKFLOW_PATH,
  PUBLIC_OUTSOURCE_CI_WORKFLOW_PATH,
  "public_outsource_worker/README.md",
  "public_outsource_worker/integration/GITHUB_ISSUE_CONTRACT.md",
  "public_outsource_worker/integration/github_action_entry.mjs",
  "public_outsource_worker/integration/github_api_client.mjs",
  "public_outsource_worker/package.json",
  "public_outsource_worker/src/adapters/bubo.mjs",
  "public_outsource_worker/src/adapters/cuckoo.mjs",
  "public_outsource_worker/src/canonical.mjs",
  "public_outsource_worker/src/dispatcher.mjs",
  "public_outsource_worker/src/errors.mjs",
  "public_outsource_worker/src/github_issue_coordinator.mjs",
  "public_outsource_worker/src/github_issue_run.mjs",
  "public_outsource_worker/src/index.mjs",
  "public_outsource_worker/src/ledger.mjs",
  "public_outsource_worker/src/registry.mjs",
  "public_outsource_worker/src/runtime.mjs",
  "public_outsource_worker/src/security.mjs",
  "public_outsource_worker/test/github_api_client.test.mjs",
  "public_outsource_worker/test/github_issue_coordinator.test.mjs",
  "public_outsource_worker/test/github_issue_run.test.mjs",
  "public_outsource_worker/test/runtime.test.mjs",
];
const FIXED_LOCAL_EXECUTION_BLOBS = new Map([
  [".github/workflows/kyiv-fast-watch.yml", "cc6a7e0b31b35015b4449867117213d7e6809311"],
  [".github/workflows/exposure-intelligence.yml", "847315833aaa1c0757fc409e06a8bdea0e00cb9f"],
  [".github/workflows/kyiv-cdse-event-queue.yml", "3943fbd1297fc5b7de0e79a32b903091daf4e629"],
  [".github/workflows/shodan-runtime-readback.yml", "9514d1ca6e38d64b345d3c0b6b7544bd4f2527ef"],
  [".github/workflows/async-job-worker.yml", "083e98b0b71fde01ab82e223d21cbb4aa32208f2"],
  [".github/workflows/continuous-external-queue.yml", "a06242941d968fba6836b39612de4aa3b06719ab"],
  [".github/workflows/runtime-anomaly-sentinel.yml", "8eb87a87a767390f145de6f994d9986aaa894d56"],
  ["runtime/exposure_queue_worker.mjs", "6b7c203895edada412ca42646ffb60065c1cc04d"],
  ["runtime/investigation_passive_index_worker.mjs", "f4259d73899050479afdc2514d5cfc0b2f93b56a"],
  ["runtime/investigation_passive_index.mjs", "99865510cbd62c1bdc476d8f153bed97ca72f192"],
  ["runtime/exposure-intelligence/src/assets.mjs", "31012d87cc60be7f361c1b7b93792889b50b20ab"],
  ["runtime/exposure-intelligence/src/checkpoint.mjs", "9a846c7bd154097b103b4776281b0e3b700e8da2"],
  ["runtime/exposure-intelligence/src/circuit.mjs", "826eb41ab3ae8bd9e63ed9244c12dc1d1b473849"],
  ["runtime/exposure-intelligence/src/engine.mjs", "1fea9df9b34d0d7cbbb8d6b8e272cc97be6735f2"],
  ["runtime/exposure-intelligence/src/errors.mjs", "56c9780ea52643f82991370c9120796a51fd1a96"],
  ["runtime/exposure-intelligence/src/evidence.mjs", "104946aafe471eb25da81c700f99afecf885ce58"],
  ["runtime/exposure-intelligence/src/http-response.mjs", "960c67acf51a832f3bcd477b3a7cfb9aa9e8b418"],
  ["runtime/exposure-intelligence/src/normalize.mjs", "b7942511021076bd7b1d256ba289999f1e8df8bc"],
  ["runtime/exposure-intelligence/src/providers/censys.mjs", "ef46060e740a64cde5e93600cb7c63200442a1a4"],
  ["runtime/exposure-intelligence/src/providers/netlas.mjs", "86d4980364006d27e7a24e2606c8999651282c2a"],
  ["runtime/exposure-intelligence/src/providers/shodan.mjs", "2efaa28abffdb08fe1906f2ba4c5587bdd877aa0"],
  ["runtime/exposure-intelligence/src/queries.mjs", "f3b11e9b48ffefae6efbe28249a934b0b5a6b030"],
  ["runtime/exposure-intelligence/src/run-lock.mjs", "369dfc5b6a80ffeb385059b4fb70f5347d39717d"],
  ["runtime/exposure-intelligence/src/scope.mjs", "12adda1c5f437eb6f677018bfb42ca96518a6f63"],
  ["runtime/exposure-intelligence/src/util.mjs", "a0c4351defd6bb100463c104abe01cf164a0ecb4"],
  ["runtime/kyiv-v3/cdse_event_queue.py", "f04ccb25b9adaf32e3a9ad817f0bbc7da2b41040"],
  ["runtime/kyiv-v3/cdse_public_delta.py", "efc8680691aac9f60a065a90199994d8d070746e"],
  ["runtime/shodan_readback.py", "3e6f32accf59a52bf42a8e5d731ae900df4277b5"],
  ["runtime/async-jobs/worker.mjs", "fdb07d194dfbca3cac4559e4963e60c72644efbe"],
  ["runtime/async-jobs/contract.mjs", "5d905100806b71ca9428edf5e4454c1e3ec6da3d"],
  ["runtime/async-jobs/contract.test.mjs", "a9908d14aeacb082aecd6d2bb416281ea346d683"],
  ["runtime/continuous-queue/worker.mjs", "3525aba2f971040c6324686023ff67230a9e336f"],
  ["runtime/anomaly-sentinel/sentinel.mjs", "f84b48da1c4b13a9fbf8c998457dfe5fa443ce62"],
  ["runtime/anomaly-sentinel/worker.mjs", "22407b4e7cb137c8d88e1c5c7d91ef1b5beb768e"],
  ["runtime/anomaly-sentinel/liveness-contracts.json", "4e6fe8abb7226a398e3b083a5a8af70228cf34ee"],
  [PUBLIC_OUTSOURCE_WORKFLOW_PATH, "10a203e1c9d3345d99fe0ff556ffcd818c9a2287"],
  ["public_outsource_worker/integration/github_action_entry.mjs", "b85534af4794c64b7d96da63a7297866a74f6893"],
  ["public_outsource_worker/integration/github_api_client.mjs", "c3f776fa3de7b15efd3ce9945e147787a1cce67c"],
  ["public_outsource_worker/src/adapters/bubo.mjs", "ee86fa9490dc73809cede8b5c2de555b8a3b3926"],
  ["public_outsource_worker/src/adapters/cuckoo.mjs", "3ff9f1ed9612e16e2f29ddda515157e13c0b50be"],
  ["public_outsource_worker/src/canonical.mjs", "3d83c75f46696e95315b82737257f6dcfc4cbf4d"],
  ["public_outsource_worker/src/dispatcher.mjs", "97bdbc919474e28deb61b486aa8915ba8779fa01"],
  ["public_outsource_worker/src/errors.mjs", "6fb71def764521e6e5817d5b56c09eec98431d72"],
  ["public_outsource_worker/src/github_issue_coordinator.mjs", "f7ae8d14e9bef8bfd1420f9a7b2711ff001f9c67"],
  ["public_outsource_worker/src/github_issue_run.mjs", "1b036607ac274521a5ab2869944e613da484b3ae"],
  ["public_outsource_worker/src/ledger.mjs", "c3901e502015c05d26fa622c76d5214243ba571f"],
  ["public_outsource_worker/src/registry.mjs", "cd7b1dbcf8ba54d4050b70613bf2a0db71187d25"],
  ["public_outsource_worker/src/runtime.mjs", "98fe626c4a7faa28b56e3361c665a2778c2a8fe2"],
  ["public_outsource_worker/src/security.mjs", "8724b173352c7060cf263dc18dcbc99c7cc18dee"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function gitBlobSha1(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const header = Buffer.from(`blob ${bytes.length}\0`, "ascii");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

export function topLevelChildren(workflow, key) {
  const workflowPath = `<top-level:${key}>`;
  const entries = yamlMappingEntries(workflow, workflowPath);
  const roots = entries.filter(
    ({ key: entryKey, ancestors }) => entryKey === key && ancestors.length === 0,
  );
  invariant(roots.length === 1, `${key} must occur exactly once at top level`);
  invariant(roots[0].value === "", `${key} must be a mapping`);

  const structural = yamlStructuralLines(workflow, workflowPath);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootPattern = new RegExp(`^(?:${escaped}|"${escaped}"|'${escaped}')\\s*:`);
  const rootIndex = structural.findIndex(
    ({ indent, line }) => indent === 0 && rootPattern.test(line),
  );
  invariant(rootIndex >= 0, `${key} must occur exactly once at top level`);
  const nested = [];
  for (let index = rootIndex + 1; index < structural.length; index += 1) {
    const candidate = structural[index];
    const content = candidate.line.slice(candidate.indent);
    if (candidate.indent === 0) {
      invariant(!/^-(?:\s|$)/.test(content), `${key} block sequences are unsupported; use a mapping`);
      break;
    }
    nested.push(candidate);
  }
  if (nested.length > 0) {
    const directIndent = Math.min(...nested.map(({ indent }) => indent));
    invariant(
      !nested.some(
        ({ indent, line }) => indent === directIndent && /^-(?:\s|$)/.test(line.slice(indent)),
      ),
      `${key} block sequences are unsupported; use a mapping`,
    );
  }

  return entries
    .filter(({ ancestors }) => ancestors.length === 1 && ancestors[0] === key)
    .map(({ key: childKey }) => childKey);
}

export function expectedManualStub(spec) {
  return `name: ${spec.workflow_name}\n\non:\n  workflow_dispatch:\n\npermissions: {}\n\njobs:\n  ${spec.job_id}:\n    if: \${{ false }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 1\n    steps:\n      - name: Shared-token lane is quarantined\n        run: echo "Disabled pending migration to an isolated short-lived credential."\n`;
}

function legacyBindingCount(workflow, secretName) {
  const escaped = secretName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dot = new RegExp(`secrets\\s*\\.\\s*${escaped}\\b`, "gi");
  const bracket = new RegExp(
    `secrets\\s*\\[\\s*["']${escaped}["']\\s*\\]`,
    "gi",
  );
  return (workflow.match(dot) ?? []).length + (workflow.match(bracket) ?? []).length;
}

function replacementSecretOwners(contract) {
  const owners = new Map();
  for (const lane of contract.critical_lanes ?? []) {
    invariant(typeof lane.lane_id === "string", "critical lane id is missing");
    invariant(typeof lane.workflow === "string", "critical lane workflow is missing");
    for (const secretName of lane.replacement_secret_names ?? []) {
      invariant(
        /^[A-Z][A-Z0-9_]{7,80}$/.test(secretName),
        `invalid replacement secret name: ${secretName}`,
      );
      invariant(!owners.has(secretName), `replacement secret reused by two lanes: ${secretName}`);
      owners.set(secretName, lane.workflow);
    }
  }
  return owners;
}

function validateManualTombstones(workflows, contract) {
  const specs = contract.manual_tombstones;
  invariant(Array.isArray(specs) && specs.length === 6, "six manual tombstones are required");
  const seen = new Set();
  for (const spec of specs) {
    invariant(!seen.has(spec.path), `duplicate manual tombstone: ${spec.path}`);
    seen.add(spec.path);
    invariant(workflows.has(spec.path), `manual tombstone is missing: ${spec.path}`);
    invariant(
      workflows.get(spec.path) === expectedManualStub(spec),
      `manual tombstone identity changed: ${spec.path}`,
    );
  }
}

function validatePinnedWorkflows(workflows, contract) {
  const pins = contract.workflow_pins;
  invariant(pins && typeof pins === "object" && !Array.isArray(pins), "workflow pins are missing");
  invariant(Object.keys(pins).length === 8, "eight privileged workflow pins are required");
  for (const [workflowPath, pin] of Object.entries(pins)) {
    invariant(workflows.has(workflowPath), `pinned workflow is missing: ${workflowPath}`);
    invariant(
      gitBlobSha1(workflows.get(workflowPath)) === pin.git_blob_sha1,
      `pinned workflow identity changed: ${workflowPath}`,
    );
  }
}

function validatePinnedSources(files, contract) {
  const pins = contract.privileged_source_pins;
  invariant(pins && typeof pins === "object" && !Array.isArray(pins), "privileged source pins are missing");
  invariant(Object.keys(pins).length === 41, "forty-one privileged source pins are required");
  for (const [sourcePath, expectedBlob] of Object.entries(pins)) {
    invariant(files.has(sourcePath), `privileged source is missing: ${sourcePath}`);
    invariant(/^[0-9a-f]{40}$/.test(expectedBlob), `privileged source pin is invalid: ${sourcePath}`);
    invariant(
      gitBlobSha1(files.get(sourcePath)) === expectedBlob,
      `privileged source identity changed: ${sourcePath}`,
    );
  }
}

function declaredJobTypes(source, label) {
  const declarations = [...source.matchAll(
    /const\s+ALLOWED_JOB_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\);/g,
  )];
  invariant(declarations.length === 1, `${label} job-type allowlist declaration must be unique`);
  const body = declarations[0][1];
  const values = [];
  const literalPattern = /(["'])([a-z][a-z0-9_]*)\1/g;
  let cursor = 0;
  for (const match of body.matchAll(literalPattern)) {
    invariant(/^[\s,]*$/.test(body.slice(cursor, match.index)), `${label} job-type allowlist must contain only literals`);
    values.push(match[2]);
    cursor = match.index + match[0].length;
  }
  invariant(/^[\s,]*$/.test(body.slice(cursor)), `${label} job-type allowlist must contain only literals`);
  invariant(new Set(values).size === values.length, `${label} job-type allowlist contains duplicates`);
  return values;
}

function validatePrivilegedLocalExecutionClosure(files, contract) {
  const requiredPins = [
    "runtime/shodan_readback.py",
    "runtime/async-jobs/worker.mjs",
    "runtime/async-jobs/contract.mjs",
    "runtime/async-jobs/contract.test.mjs",
    "runtime/continuous-queue/worker.mjs",
    ...PUBLIC_OUTSOURCE_SOURCE_IMPORTS.keys(),
  ];
  for (const sourcePath of requiredPins) {
    invariant(contract.privileged_source_pins?.[sourcePath], `privileged local source is not pinned: ${sourcePath}`);
  }

  const shodanWorkflow = files.get(".github/workflows/shodan-runtime-readback.yml");
  invariant(
    JSON.stringify(topLevelChildren(shodanWorkflow, "on")) === JSON.stringify(["schedule"])
      && shodanWorkflow.includes("- cron: '17 3 * * *'")
      && shodanWorkflow.includes("if: github.event_name == 'schedule'"),
    "Shodan secret-bearing workflow must be default-branch schedule-only",
  );
  const shodanRuns = yamlMappingEntries(
    shodanWorkflow,
    ".github/workflows/shodan-runtime-readback.yml",
  ).filter(({ key }) => key === "run");
  invariant(
    shodanRuns.length === 1 && shodanRuns[0].value === "|",
    "Shodan secret-bearing workflow must contain exactly one run step",
  );
  const expectedShodanCredentialStep = `      - name: Verify Shodan credential without search spend
        shell: bash
        env:
          SHODAN_API_KEY: \${{ secrets.SHODAN_API_KEY }}
        run: |
          set -euo pipefail
          set +x
          if [[ -z "$SHODAN_API_KEY" ]]; then
            echo '{"provider":"shodan","credential_status":"FAILED","reason":"SHODAN_CREDENTIAL_MISSING"}'
            exit 1
          fi
          echo "::add-mask::$SHODAN_API_KEY"
          python -I -S runtime/shodan_readback.py
`;
  invariant(
    shodanWorkflow.endsWith(expectedShodanCredentialStep),
    "Shodan workflow execution closure must be the exact pinned credential-reader step",
  );

  const asyncWorkflow = files.get(".github/workflows/async-job-worker.yml");
  const asyncRuns = yamlMappingEntries(
    asyncWorkflow,
    ".github/workflows/async-job-worker.yml",
  ).filter(({ key }) => key === "run");
  invariant(
    asyncRuns.length === 1 && asyncRuns[0].value === "node runtime/async-jobs/worker.mjs",
    "Async workflow execution closure must contain only its exact pinned issue worker command",
  );
  invariant(
    asyncWorkflow.includes("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020")
      && asyncWorkflow.includes("node-version: '24'")
      && asyncWorkflow.includes("package-manager-cache: false")
      && !asyncWorkflow.includes("node-version: '20'"),
    "Async issues-write lane must use the reviewed Node 24 target and action runtime",
  );
  const asyncWorker = files.get("runtime/async-jobs/worker.mjs");
  invariant(
    JSON.stringify([...asyncWorker.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]))
      === JSON.stringify(["node:fs", "./contract.mjs"]),
    "Async worker import closure must contain only node:fs and its pinned contract",
  );
  invariant(
    !/node:child_process|\bexecFile\b|\bspawn\b|\bnpm\b|\bimport\s*\(|\brequire\s*\(/.test(asyncWorker),
    "Token-bearing async worker cannot launch repository or package-manager child processes",
  );
  const asyncContract = files.get("runtime/async-jobs/contract.mjs");
  invariant(
    JSON.stringify(declaredJobTypes(asyncContract, "Async worker")) === JSON.stringify(ASYNC_TOKEN_WORKER_JOB_TYPES),
    "Async worker job-type allowlist drifted from the exact token-safe set",
  );
  invariant(
    (asyncContract.match(/ALLOWED_JOB_TYPES/g) ?? []).length === 3
      && asyncContract.includes("if (!ALLOWED_JOB_TYPES.has(job.job_type))")
      && asyncContract.includes("export { ALLOWED_JOB_TYPES };")
      && !asyncContract.includes("utility_search_self_test"),
    "Async worker job-type allowlist semantics were mutated",
  );

  const continuousWorkflowPath = ".github/workflows/continuous-external-queue.yml";
  const continuousWorkflow = files.get(continuousWorkflowPath);
  const continuousRuns = yamlMappingEntries(
    continuousWorkflow,
    continuousWorkflowPath,
  ).filter(({ key }) => key === "run");
  invariant(
    JSON.stringify(topLevelChildren(continuousWorkflow, "on")) === JSON.stringify(["issues", "schedule"])
      && continuousWorkflow.includes("- cron: '*/5 * * * *'"),
    "Continuous queue must rely only on owner issue events and the five-minute schedule",
  );
  invariant(
    continuousRuns.length === 1
      && continuousRuns[0].value === "node runtime/continuous-queue/worker.mjs",
    "Continuous queue execution closure must contain only its exact pinned worker command",
  );
  invariant(
    continuousWorkflow.includes("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020")
      && continuousWorkflow.includes("node-version: '24'")
      && continuousWorkflow.includes("package-manager-cache: false")
      && !continuousWorkflow.includes("node-version: '20'"),
    "Continuous issues-write lane must use the reviewed Node 24 target and action runtime",
  );
  const continuousWorker = files.get("runtime/continuous-queue/worker.mjs");
  invariant(
    JSON.stringify([...continuousWorker.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]))
      === JSON.stringify(["node:child_process", "node:path", "node:util", "node:url"]),
    "Continuous queue import closure drifted",
  );
  invariant(
    !/\bnpm\b|utility_search_self_test|\/actions\/workflows\/continuous-external-queue\.yml\/dispatches/.test(continuousWorker),
    "Continuous queue cannot install packages or self-dispatch with write authority",
  );
  invariant(
    continuousWorker.includes("const TOKENLESS_CHILD_ENV = Object.freeze({});")
      && (continuousWorker.match(/execFileAsync\(\s*process\.execPath/g) ?? []).length === 3
      && (continuousWorker.match(/env: TOKENLESS_CHILD_ENV/g) ?? []).length === 3,
    "Continuous queue child execution must use exact tokenless Node invocations",
  );
  invariant(
    JSON.stringify(declaredJobTypes(continuousWorker, "Continuous queue"))
      === JSON.stringify(CONTINUOUS_TOKEN_WORKER_JOB_TYPES),
    "Continuous queue job-type allowlist drifted from the exact public set",
  );
  invariant(
    continuousWorker.includes('if (job.sensitivity !== "public")')
      && continuousWorker.includes('if (job.payload_ref !== undefined)')
      && continuousWorker.includes("issue.user?.login === authorizedOwner")
      && continuousWorker.includes('issue.user?.login === "github-actions[bot]" && job.producer === INTERNAL_PRODUCER')
      && continuousWorker.includes('comment?.user?.login !== "github-actions[bot]"')
      && continuousWorker.includes("creator=${encodeURIComponent(creator)}")
      && continuousWorker.includes('listIssuesByCreator("open", repositoryOwner)')
      && continuousWorker.includes('listIssuesByCreator("open", "github-actions[bot]")')
      && continuousWorker.includes("fields_not_allowlisted")
      && continuousWorker.includes("RESERVATION_LEASE_MS")
      && continuousWorker.includes("reservationTimestampMs(record.reserved_at_utc)")
      && continuousWorker.includes("reconcilePlanState(plan, allQueue")
      && continuousWorker.includes("assertNoDuplicateQueueTaskKeys(issues, repositoryOwner)")
      && continuousWorker.includes('throw new Error("ambiguous_task_history")')
      && continuousWorker.includes('throw new Error("ambiguous_terminal_status_history")')
      && continuousWorker.includes("inspection.terminalSucceeded === plan.tasks.length")
      && continuousWorker.includes("inspection.terminalFailed === 0")
      && continuousWorker.includes("inspection.terminalRejected === 0")
      && continuousWorker.includes("inspection.invalidEvidence === 0")
      && continuousWorker.includes('return "INVALID_EVIDENCE"')
      && continuousWorker.includes("planTerminalOutcome(plan, remaining, inspection)")
      && continuousWorker.includes("queueJobIdPrefix")
      && continuousWorker.includes("expectedRepository")
      && continuousWorker.includes('const INTERNAL_PRODUCER = "continuous_queue_refill_v2";')
      && continuousWorker.includes('const STATUS_EPOCH = "continuous_queue_status_v2";')
      && continuousWorker.includes('identity.push(task.payload?.probe || "", String(task.payload?.hold_ms ?? ""))')
      && continuousWorker.includes('exactStatusField(lines, "task_identity")')
      && !continuousWorker.includes("historicalSeen"),
    "Continuous queue public-input and producer gates drifted",
  );
}

function staticModuleSpecifiers(source) {
  return [...source.matchAll(
    /(?:^|\n)(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];/g,
  )].map((match) => match[1]);
}

export function validatePublicOutsourceBoundary(files, contract) {
  const workflow = files.get(PUBLIC_OUTSOURCE_WORKFLOW_PATH);
  const ciWorkflow = files.get(PUBLIC_OUTSOURCE_CI_WORKFLOW_PATH);
  invariant(
    typeof workflow === "string" && typeof ciWorkflow === "string",
    "public outsource workflow closure is missing",
  );

  const authority = validateWorkflowAuthority(workflow, PUBLIC_OUTSOURCE_WORKFLOW_PATH);
  validatePrivilegedExecutionEnvironment(workflow, PUBLIC_OUTSOURCE_WORKFLOW_PATH);
  validatePinnedExecutableReferences(
    authority.executableReferences,
    authority.checkoutCredentialDisabledSteps,
    authority.nodeTarget24Steps,
    authority.packageManagerCacheDisabledSteps,
    PUBLIC_OUTSOURCE_WORKFLOW_PATH,
  );
  const references = authority.executableReferences.map(({ rawReference }) => {
    const decoded = decodeYamlScalar(rawReference);
    return typeof decoded === "string" ? decoded : rawReference.trim();
  });
  invariant(
    JSON.stringify(references) === JSON.stringify([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]),
    "public outsource lane must use only the reviewed Node 24 action runtime closure",
  );
  invariant(
    authority.hasExplicitTopLevelPermissions
      && authority.hasWriteAuthority
      && JSON.stringify(topLevelChildren(workflow, "permissions"))
        === JSON.stringify(["contents", "issues"])
      && JSON.stringify(topLevelChildren(workflow, "on")) === JSON.stringify(["issues"])
      && JSON.stringify(topLevelChildren(workflow, "jobs")) === JSON.stringify(["dispatch"])
      && workflow.includes("  issues:\n    types: [opened]")
      && !/schedule|workflow_dispatch|repository_dispatch|pull_request|issue_comment|discussion/.test(workflow),
    "public outsource trigger and authority boundary drifted",
  );
  invariant(
    workflow.includes("startsWith(github.event.issue.title, '[OUTSOURCE-TASK] ')")
      && workflow.includes("github.event.issue.user.login == github.repository_owner")
      && !workflow.includes("github.actor == 'github-actions[bot]'")
      && workflow.includes("group: public-outsource-${{ github.event.issue.title }}")
      && workflow.includes("cancel-in-progress: false"),
    "public outsource owner gate or issue-scoped concurrency drifted",
  );
  const runs = yamlMappingEntries(workflow, PUBLIC_OUTSOURCE_WORKFLOW_PATH)
    .filter(({ key }) => key === "run");
  invariant(
    runs.length === 1
      && runs[0].value === "node public_outsource_worker/integration/github_action_entry.mjs"
      && (workflow.match(/GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/g) ?? []).length === 1
      && workflow.includes("OUTSOURCE_BOT_LOGIN: github-actions[bot]"),
    "public outsource execution command and native-token closure drifted",
  );

  const ciAuthority = validateWorkflowAuthority(ciWorkflow, PUBLIC_OUTSOURCE_CI_WORKFLOW_PATH);
  validatePrivilegedExecutionEnvironment(ciWorkflow, PUBLIC_OUTSOURCE_CI_WORKFLOW_PATH);
  validatePinnedExecutableReferences(
    ciAuthority.executableReferences,
    ciAuthority.checkoutCredentialDisabledSteps,
    ciAuthority.nodeTarget24Steps,
    ciAuthority.packageManagerCacheDisabledSteps,
    PUBLIC_OUTSOURCE_CI_WORKFLOW_PATH,
  );
  const ciReferences = ciAuthority.executableReferences.map(({ rawReference }) => {
    const decoded = decodeYamlScalar(rawReference);
    return typeof decoded === "string" ? decoded : rawReference.trim();
  });
  invariant(
    ciAuthority.hasExplicitTopLevelPermissions
      && !ciAuthority.hasWriteAuthority
      && JSON.stringify(topLevelChildren(ciWorkflow, "permissions")) === JSON.stringify(["contents"])
      && JSON.stringify(topLevelChildren(ciWorkflow, "on"))
        === JSON.stringify(["pull_request", "workflow_dispatch"])
      && JSON.stringify(ciReferences) === JSON.stringify([
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      ])
      && ciWorkflow.includes("working-directory: public_outsource_worker")
      && ciWorkflow.includes("run: node --test"),
    "public outsource CI boundary drifted",
  );

  for (const [sourcePath, expectedSpecifiers] of PUBLIC_OUTSOURCE_SOURCE_IMPORTS) {
    const source = files.get(sourcePath);
    invariant(typeof source === "string", `public outsource source is missing: ${sourcePath}`);
    invariant(
      contract.privileged_source_pins?.[sourcePath],
      `public outsource source is not privileged-pinned: ${sourcePath}`,
    );
    invariant(
      JSON.stringify(staticModuleSpecifiers(source)) === JSON.stringify(expectedSpecifiers),
      `public outsource import closure drifted: ${sourcePath}`,
    );
    invariant(
      !/node:child_process|\bexecFile\b|\bspawn\b|\bnpm\b|\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\bnew\s+Function\b/.test(source),
      `public outsource source can execute an unreviewed command or dynamic module: ${sourcePath}`,
    );
    invariant(
      !/\bopenai\b|\bgpt(?:-[0-9.]+)?\b/i.test(source),
      `public outsource privileged closure cannot depend on GPT: ${sourcePath}`,
    );
    if (sourcePath !== "public_outsource_worker/integration/github_action_entry.mjs") {
      invariant(
        !/process\.env/.test(source),
        `public outsource environment authority escaped its entrypoint: ${sourcePath}`,
      );
    }
  }

  const privilegedText = [...PUBLIC_OUTSOURCE_SOURCE_IMPORTS.keys()]
    .map((sourcePath) => files.get(sourcePath))
    .join("\n");
  const urls = [...privilegedText.matchAll(/https:\/\/[^\s"'`]+/g)].map((match) => match[0]);
  invariant(
    JSON.stringify(urls) === JSON.stringify([
      "https://api.github.com",
      "https://public-api.prozorro.gov.ua/api/2.5/tenders",
    ]),
    "public outsource network authority escaped its two reviewed public APIs",
  );
  invariant(
    !/(?:^|[^s])http:|\b(?:ftp|file|data|ws|wss):|\bnew\s+URL\s*\(/i.test(privilegedText),
    "public outsource privileged closure contains an unreviewed URL scheme",
  );

  const entry = files.get("public_outsource_worker/integration/github_action_entry.mjs");
  const githubClient = files.get("public_outsource_worker/integration/github_api_client.mjs");
  const coordinator = files.get("public_outsource_worker/src/github_issue_coordinator.mjs");
  const issueRun = files.get("public_outsource_worker/src/github_issue_run.mjs");
  const security = files.get("public_outsource_worker/src/security.mjs");
  const cuckoo = files.get("public_outsource_worker/src/adapters/cuckoo.mjs");
  const bubo = files.get("public_outsource_worker/src/adapters/bubo.mjs");
  const runtime = files.get("public_outsource_worker/src/runtime.mjs");
  invariant(
    entry.includes('requiredEnv("GITHUB_EVENT_PATH")')
      && entry.includes('requiredEnv("GITHUB_REPOSITORY")')
      && entry.includes('requiredEnv("GITHUB_TOKEN")')
      && JSON.stringify([...entry.matchAll(/requiredEnv\("([A-Z_]+)"\)/g)].map((match) => match[1]))
        === JSON.stringify(["GITHUB_EVENT_PATH", "GITHUB_REPOSITORY", "GITHUB_TOKEN"])
      && (entry.match(/await runBoundedIssueChain\s*\(/g) ?? []).length === 1
      && (entry.match(/process\.env\.OUTSOURCE_BOT_LOGIN/g) ?? []).length === 1,
    "public outsource action entry escaped the bounded issue chain",
  );
  invariant(
    githubClient.includes('const GITHUB_API = "https://api.github.com";')
      && githubClient.includes("if (!path.startsWith(`${repoRoot}/`))")
      && githubClient.includes('redirect: "error"')
      && githubClient.includes("for (let page = 1; page <= 10; page += 1)")
      && githubClient.includes('method: "POST"')
      && (githubClient.match(/await fetchImpl\s*\(/g) ?? []).length === 1
      && !/\/dispatches|\/actions\/workflows|graphql|contents\//i.test(githubClient),
    "public outsource GitHub client escaped repository-scoped issue I/O",
  );
  invariant(
    coordinator.includes('if (event.action !== "opened")')
      && coordinator.includes("event.repository?.private !== false")
      && coordinator.includes("authorLogin !== ownerLogin")
      && coordinator.includes('envelope.worker !== "cuckoo"')
      && coordinator.includes('next.worker !== "bubo"')
      && coordinator.includes("findCurrentTerminal")
      && coordinator.includes("result_sha256")
      && coordinator.includes("issue?.user?.login === trustedAuthorLogin")
      && coordinator.includes("event.repository.owner.login")
      && coordinator.includes("generatedByLogin: botLogin")
      && (coordinator.match(/await dispatcher\.dispatch\(runtimeEnvelope\)/g) ?? []).length === 1,
    "public outsource descriptor, owner, or immutable-terminal gate drifted",
  );
  invariant(
    issueRun.includes('rootDescriptor.envelope.worker !== "cuckoo"')
      && issueRun.includes('rootDescriptor.envelope.capability !== "prozorro_snapshot_v1"')
      && issueRun.includes("let adapterExecutions = parentDecision.comment_body ? 1 : 0")
      && issueRun.includes("if (!childTerminal)")
      && issueRun.includes("adapterExecutions += 1")
      && issueRun.includes("resolveRuntimeEnvelope(")
      && issueRun.includes("findUniqueTaskIssue(freshIssues, childTaskId, botLogin)")
      && issueRun.includes("created.user?.login !== botLogin")
      && issueRun.includes("const afterCreateIssues = await github.issues()")
      && issueRun.includes("const authoritative = findUniqueTaskIssue(")
      && (issueRun.match(/const verified = parseBotTerminalComment\(/g) ?? []).length === 2
      && (issueRun.match(/await coordinateIssueTask\s*\(/g) ?? []).length === 1
      && (issueRun.match(/await dispatcher\.dispatch\(buboEnvelope\)/g) ?? []).length === 1,
    "public outsource same-run chain is no longer bounded to Cuckoo then BUBO",
  );
  invariant(
    security.includes('input.sensitivity !== "PUBLIC"')
      && security.includes("assertNoForbiddenFields(input.payload)")
      && security.includes('"coordinates"')
      && security.includes('"targeting"')
      && security.includes('"private_communication"'),
    "public outsource PUBLIC-only payload boundary drifted",
  );
  invariant(
    cuckoo.includes('const RECORD_ID = /^[0-9a-fA-F]{32}$/;')
      && cuckoo.includes('const API_ROOT = "https://public-api.prozorro.gov.ua/api/2.5/tenders";')
      && cuckoo.includes('redirect: "error"')
      && cuckoo.includes("AbortSignal.timeout(15_000)")
      && (cuckoo.match(/await fetchImpl\s*\(/g) ?? []).length === 1
      && cuckoo.includes("candidate_only: true")
      && cuckoo.includes("sha256Bytes(rawBytes)")
      && cuckoo.includes('archive_status: "NOT_ARCHIVED_PUBLIC_CANARY"')
      && bubo.includes('canonical_admission: "PENDING_VERIFIER"')
      && bubo.includes("no inference of wrongdoing is made")
      && runtime.includes('"cuckoo",\n      "prozorro_snapshot_v1"')
      && runtime.includes('.register("bubo", "evidence_packet_v1"'),
    "public outsource capability, official-source, or verifier gate drifted",
  );
}

function validateFixedLocalExecutionBlobs(files, contract) {
  const configuredPaths = [
    ...Object.keys(contract.workflow_pins ?? {}),
    ...Object.keys(contract.privileged_source_pins ?? {}),
  ].sort();
  const fixedPaths = [...FIXED_LOCAL_EXECUTION_BLOBS.keys()].sort();
  invariant(
    JSON.stringify(configuredPaths) === JSON.stringify(fixedPaths),
    "fixed privileged blob set drifted from the complete contract closure",
  );
  for (const [sourcePath, expectedBlob] of FIXED_LOCAL_EXECUTION_BLOBS) {
    const configuredBlob = sourcePath.startsWith(".github/workflows/")
      ? contract.workflow_pins?.[sourcePath]?.git_blob_sha1
      : contract.privileged_source_pins?.[sourcePath];
    invariant(configuredBlob === expectedBlob, `fixed local execution pin drifted: ${sourcePath}`);
    invariant(
      gitBlobSha1(files.get(sourcePath) ?? "") === expectedBlob,
      `fixed local execution blob drifted: ${sourcePath}`,
    );
  }
}

function decodeYamlScalar(token) {
  const trimmed = token.trim();
  if (/^"(?:\\.|[^"\\])*"$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (/^'(?:''|[^'])*'$/.test(trimmed)) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) return trimmed;
  if (trimmed === "{}") return trimmed;
  return null;
}

function stripYamlInlineComment(value) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character !== "'") continue;
      if (value[index + 1] === "'") {
        index += 1;
      } else {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function yamlStructuralLines(workflow, workflowPath) {
  const structural = [];
  let blockParentIndent = null;
  const lines = workflow.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const indentation = line.match(/^[ \t]*/)?.[0] ?? "";
    invariant(!indentation.includes("\t"), `tab indentation is unsupported: ${workflowPath}:${index + 1}`);
    const indent = indentation.length;
    if (blockParentIndent !== null) {
      if (indent > blockParentIndent) continue;
      blockParentIndent = null;
    }
    if (/^\s*#/.test(line)) continue;
    structural.push({ line, lineNumber: index + 1, indent });

    const expressionSafe = line.replace(/\$\{\{.*?\}\}/g, "GITHUB_EXPRESSION");
    const withoutComment = stripYamlInlineComment(expressionSafe).trim();
    if (/(?:^|:\s*)[>|](?:(?:[+-][1-9]?)|(?:[1-9][+-]?))?\s*$/.test(withoutComment)) {
      const sequencePrefix = line.slice(indent).match(/^-\s+/)?.[0] ?? "";
      blockParentIndent = indent + sequencePrefix.length;
    }
  }
  return structural;
}

function validateCanonicalQuotedSegments(value, workflowPath, lineNumber) {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (singleQuoted) {
      if (character !== "'") continue;
      if (value[index + 1] === "'") {
        index += 1;
      } else {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      invariant(
        character !== "\\",
        `escaped double-quoted YAML scalars are unsupported: ${workflowPath}:${lineNumber}`,
      );
      if (character === '"') doubleQuoted = false;
      continue;
    }
    if (character === "'") singleQuoted = true;
    if (character === '"') doubleQuoted = true;
  }
}

function yamlMappingEntries(workflow, workflowPath) {
  const entries = [];
  const contexts = [];
  const sequenceCounts = new Map();
  const seenKeys = new Set();
  for (const structural of yamlStructuralLines(workflow, workflowPath)) {
    let content = structural.line.slice(structural.indent);
    while (contexts.length > 0 && contexts.at(-1).indent >= structural.indent) contexts.pop();

    const sequence = content.match(/^-\s+/);
    let effectiveIndent = structural.indent;
    if (sequence) {
      const parent = contexts.map((context) => context.id).join("/");
      const counterKey = `${parent}@${structural.indent}`;
      const sequenceNumber = (sequenceCounts.get(counterKey) ?? 0) + 1;
      sequenceCounts.set(counterKey, sequenceNumber);
      contexts.push({ indent: structural.indent, id: `[${sequenceNumber}]` });
      effectiveIndent += sequence[0].length;
      content = content.slice(sequence[0].length);
    }

    const rawCanonical = stripYamlInlineComment(content).trim();
    validateCanonicalQuotedSegments(rawCanonical, workflowPath, structural.lineNumber);
    const expressionSafe = content.replace(/\$\{\{.*?\}\}/g, "GITHUB_EXPRESSION");
    const canonical = stripYamlInlineComment(expressionSafe).trim();
    invariant(!/^[?:](?:\s|$)/.test(canonical), `explicit YAML mapping keys are unsupported: ${workflowPath}:${structural.lineNumber}`);
    invariant(
      !/^(?:![^\s]*|&[A-Za-z0-9_-]+|\*[A-Za-z0-9_-]+)(?:\s|$)/.test(canonical),
      `YAML tags, anchors, and aliases are unsupported: ${workflowPath}:${structural.lineNumber}`,
    );
    invariant(!canonical.startsWith("{"), `flow mappings are unsupported: ${workflowPath}:${structural.lineNumber}`);

    const match = content.match(
      /^((?:"(?:\\.|[^"\\])*")|(?:'(?:''|[^'])*')|(?:[A-Za-z_][A-Za-z0-9_-]*))\s*:\s*(.*?)\s*$/,
    );
    if (!match) {
      invariant(
        sequence,
        `multiline scalar values are unsupported: ${workflowPath}:${structural.lineNumber}`,
      );
      invariant(!canonical.startsWith("["), `nested flow sequences are unsupported: ${workflowPath}:${structural.lineNumber}`);
      continue;
    }
    const key = decodeYamlScalar(match[1]);
    invariant(typeof key === "string", `unsupported YAML scalar key: ${workflowPath}:${structural.lineNumber}`);
    const value = stripYamlInlineComment(match[2]).trim();
    if (value.startsWith('"')) {
      invariant(
        /^"(?:\\.|[^"\\])*"$/.test(value) && typeof decodeYamlScalar(value) === "string",
        `multiline or unsupported double-quoted YAML scalar: ${workflowPath}:${structural.lineNumber}`,
      );
      invariant(
        !value.includes("\\"),
        `escaped double-quoted YAML scalars are unsupported: ${workflowPath}:${structural.lineNumber}`,
      );
    }
    if (value.startsWith("'")) {
      invariant(
        /^'(?:''|[^'])*'$/.test(value),
        `multiline single-quoted YAML scalars are unsupported: ${workflowPath}:${structural.lineNumber}`,
      );
    }
    invariant(
      !/^(?:![^\s]*|&[A-Za-z0-9_-]+|\*[A-Za-z0-9_-]+)(?:\s|$)/.test(value),
      `YAML tags, anchors, and aliases are unsupported: ${workflowPath}:${structural.lineNumber}`,
    );
    if (value.startsWith("{")) {
      invariant(
        key === "permissions" && value === "{}",
        `flow mappings are unsupported: ${workflowPath}:${structural.lineNumber}`,
      );
    }
    if (value.startsWith("[")) {
      invariant(
        /^\[(?:[A-Za-z0-9_./-]+(?:,\s*[A-Za-z0-9_./-]+)*)?\]$/.test(value),
        `non-canonical flow sequence is unsupported: ${workflowPath}:${structural.lineNumber}`,
      );
    }

    const ancestors = contexts.map((context) => context.id);
    const scope = ancestors.join("/");
    const keyIdentity = `${scope}@${effectiveIndent}:${key}`;
    invariant(!seenKeys.has(keyIdentity), `duplicate YAML mapping key: ${workflowPath}:${structural.lineNumber}`);
    seenKeys.add(keyIdentity);
    entries.push({ key, value, ancestors });
    if (value === "") contexts.push({ indent: effectiveIndent, id: key });
  }
  return entries;
}

function validateWorkflowAuthority(workflow, workflowPath) {
  const permissionKeys = new Set([
    "actions", "artifact-metadata", "attestations", "checks", "code-quality",
    "contents", "deployments", "discussions", "id-token", "issues", "models",
    "packages", "pages", "pull-requests", "repository-projects", "security-events",
    "statuses", "vulnerability-alerts",
  ]);
  const entries = yamlMappingEntries(workflow, workflowPath);
  const topLevelPermissions = entries.filter(
    ({ key, ancestors }) => key === "permissions" && ancestors.length === 0,
  );
  const hasExplicitTopLevelPermissions = topLevelPermissions.length === 1;
  let hasWriteAuthority = false;
  const executableReferences = [];
  const checkoutCredentialDisabledSteps = new Set();
  const nodeTarget24Steps = new Set();
  const packageManagerCacheDisabledSteps = new Set();
  for (const { key, value, ancestors } of entries) {
    if (key === "secrets") {
      throw new Error(`workflow secret delegation mapping forbidden: ${workflowPath}`);
    }
    if (key === "permissions") {
      invariant(
        ancestors.length === 0 || (ancestors.length === 2 && ancestors[0] === "jobs"),
        `permissions mapping occurs outside workflow or job scope: ${workflowPath}`,
      );
      const scalar = decodeYamlScalar(value.split(/\s+#/, 1)[0]);
      invariant(value.trim() === "" || scalar === "{}", `broad workflow permissions forbidden: ${workflowPath}`);
      if (value.trim() === "") {
        const childAncestors = [...ancestors, "permissions"];
        if (ancestors.length === 0) topLevelChildren(workflow, "permissions");
        invariant(
          entries.some(
            ({ ancestors: candidateAncestors }) =>
              JSON.stringify(candidateAncestors) === JSON.stringify(childAncestors),
          ),
          `permissions must be a non-empty canonical mapping or {}: ${workflowPath}`,
        );
      }
    }
    if (key === "uses") {
      executableReferences.push({ rawReference: value, stepScope: ancestors.join("/") });
    }
    if (
      key === "persist-credentials"
      && ancestors.at(-1) === "with"
      && decodeYamlScalar(value) === "false"
    ) {
      checkoutCredentialDisabledSteps.add(ancestors.slice(0, -1).join("/"));
    }
    if (
      key === "node-version"
      && ancestors.at(-1) === "with"
      && decodeYamlScalar(value) === "24"
    ) {
      nodeTarget24Steps.add(ancestors.slice(0, -1).join("/"));
    }
    if (
      key === "package-manager-cache"
      && ancestors.at(-1) === "with"
      && decodeYamlScalar(value) === "false"
    ) {
      packageManagerCacheDisabledSteps.add(ancestors.slice(0, -1).join("/"));
    }
    if (ancestors.at(-1) !== "permissions") continue;
    invariant(permissionKeys.has(key), `unknown GitHub permission key: ${workflowPath}:${key}`);
    const scalar = decodeYamlScalar(value.split(/\s+#/, 1)[0]);
    invariant(
      scalar === "read" || scalar === "write" || scalar === "none",
      `permission value must be a canonical read, write, or none scalar: ${workflowPath}`,
    );
    const authorityScope = `${workflowPath}|${ancestors.join("/")}|${key}`;
    if (scalar === "read") {
      invariant(
        key === "contents" || READ_AUTHORITY_SCOPES.has(authorityScope),
        `read permission scope is not allowlisted: ${workflowPath}:${key}`,
      );
    }
    if (scalar === "write") {
      hasWriteAuthority = true;
      invariant(
        WRITE_AUTHORITY_SCOPES.has(authorityScope),
        `write permission scope is not allowlisted: ${authorityScope}`,
      );
    }
    if (key === "contents") {
      invariant(scalar === "read" || scalar === "none", `contents permission must stay read-only: ${workflowPath}`);
    }
    if (key === "id-token") {
      invariant(scalar !== "write", `OIDC write permission is not allowlisted: ${workflowPath}`);
    }
  }
  return {
    checkoutCredentialDisabledSteps,
    executableReferences,
    hasExplicitTopLevelPermissions,
    hasWriteAuthority,
    nodeTarget24Steps,
    packageManagerCacheDisabledSteps,
  };
}

function validatePinnedExecutableReferences(
  references,
  checkoutCredentialDisabledSteps,
  nodeTarget24Steps,
  packageManagerCacheDisabledSteps,
  workflowPath,
) {
  for (const { rawReference, stepScope } of references) {
    const decoded = decodeYamlScalar(rawReference);
    const reference = typeof decoded === "string" ? decoded : rawReference.trim();
    invariant(
      !reference.startsWith("./"),
      `local executable action references are forbidden in privileged workflows: ${workflowPath}:${reference}`,
    );
    invariant(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/.test(reference),
      `external executable reference must use a full commit SHA: ${workflowPath}:${reference}`,
    );
    if (reference.startsWith("actions/")) {
      const [actionName] = reference.split("@", 1);
      const expectedPin = OFFICIAL_NODE24_ACTION_PINS.get(actionName);
      invariant(
        expectedPin && reference === `${actionName}@${expectedPin}`,
        `official action must use the reviewed Node 24 runtime pin: ${workflowPath}:${reference}`,
      );
    }
    if (reference.startsWith("actions/checkout@")) {
      invariant(
        checkoutCredentialDisabledSteps.has(stepScope),
        `privileged checkout must disable persisted credentials: ${workflowPath}:${stepScope}`,
      );
    }
    if (reference.startsWith("actions/setup-node@")) {
      invariant(
        nodeTarget24Steps.has(stepScope),
        `setup-node must select the Node 24 target: ${workflowPath}:${stepScope}`,
      );
      invariant(
        packageManagerCacheDisabledSteps.has(stepScope),
        `setup-node automatic package-manager cache must be disabled: ${workflowPath}:${stepScope}`,
      );
    }
  }
}


function validateAnomalySentinelBoundary(files) {
  const workflowPath = ".github/workflows/runtime-anomaly-sentinel.yml";
  const workflow = files.get(workflowPath);
  const worker = files.get("runtime/anomaly-sentinel/worker.mjs");
  const core = files.get("runtime/anomaly-sentinel/sentinel.mjs");
  const livenessText = files.get("runtime/anomaly-sentinel/liveness-contracts.json");
  invariant(
    typeof workflow === "string"
      && typeof worker === "string"
      && typeof core === "string"
      && typeof livenessText === "string",
    "anomaly sentinel closure is missing",
  );

  const authority = validateWorkflowAuthority(workflow, workflowPath);
  validatePrivilegedExecutionEnvironment(workflow, workflowPath);
  validatePinnedExecutableReferences(
    authority.executableReferences,
    authority.checkoutCredentialDisabledSteps,
    authority.nodeTarget24Steps,
    authority.packageManagerCacheDisabledSteps,
    workflowPath,
  );
  const references = authority.executableReferences.map(({ rawReference }) => {
    const decoded = decodeYamlScalar(rawReference);
    return typeof decoded === "string" ? decoded : rawReference.trim();
  });
  invariant(
    JSON.stringify(references) === JSON.stringify([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]),
    "anomaly sentinel must use only the reviewed Node 24 action runtime closure",
  );
  invariant(
    authority.hasExplicitTopLevelPermissions
      && !authority.hasWriteAuthority
      && JSON.stringify(topLevelChildren(workflow, "permissions")) === JSON.stringify(["contents"])
      && JSON.stringify(topLevelChildren(workflow, "jobs")) === JSON.stringify(["preflight", "observe"])
      && workflow.includes("    permissions:\n      actions: read\n      contents: read\n      issues: read")
      && !/:\s*write\b|write-all|id-token:/i.test(workflow),
    "anomaly sentinel authority must remain a two-job read-only shadow",
  );
  invariant(
    JSON.stringify(topLevelChildren(workflow, "on")) === JSON.stringify(["push", "schedule"])
      && workflow.includes("branches: [main]")
      && workflow.includes("- cron: '3-53/10 * * * *'")
      && !workflow.includes("workflow_dispatch")
      && !workflow.includes("pull_request"),
    "anomaly sentinel must execute only from default-branch push or the ten-minute schedule",
  );
  invariant(
    (workflow.match(/^\s+run:\s*/gm) ?? []).length === 2
      && (workflow.match(/node --test runtime\/anomaly-sentinel\/\*\.test\.mjs/g) ?? []).length === 1
      && (workflow.match(/node runtime\/anomaly-sentinel\/canary\.mjs/g) ?? []).length === 1
      && (workflow.match(/run: node runtime\/anomaly-sentinel\/worker\.mjs/g) ?? []).length === 1
      && workflow.includes("  observe:\n    needs: preflight")
      && (workflow.match(/ref:\s*\$\{\{ github\.sha \}\}/g) ?? []).length === 2
      && (workflow.match(/persist-credentials:\s*false/g) ?? []).length === 2
      && (workflow.match(/node-version:\s*'24'/g) ?? []).length === 2
      && (workflow.match(/package-manager-cache:\s*false/g) ?? []).length === 2,
    "anomaly sentinel execution closure must retain exact read-only preflight and observe jobs",
  );
  invariant(
    (workflow.match(/GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/g) ?? []).length === 1
      && workflow.includes("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}")
      && workflow.includes("EXPECTED_CANCEL_WORKFLOWS: Kyiv V3 public collector")
      && (workflow.match(/GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/g) ?? []).length === 1,
    "anomaly sentinel token and source-branch inputs drifted",
  );
  const cycleStart = worker.indexOf("export async function runSentinelCycle(");
  const cycleEnd = worker.indexOf("\nasync function main()", cycleStart);
  const productionCycle = cycleStart >= 0 && cycleEnd > cycleStart
    ? worker.slice(cycleStart, cycleEnd)
    : "";
  invariant(
    worker.includes('const defaultBranch = requiredEnv("DEFAULT_BRANCH");')
      && worker.includes('const pinnedCommit = requiredEnv("GITHUB_SHA");')
      && worker.includes('"/git/ref/heads/" + encodeURIComponent(defaultBranch)')
      && worker.includes('"/git/commits/" + pinnedCommit')
      && worker.includes('"/git/trees/" + treeSha + "?recursive=1"')
      && worker.includes('fail("pinned_tree_incomplete")')
      && worker.includes("head_repository")
      && worker.includes("event=schedule")
      && worker.includes("&created=")
      && worker.includes("const GITHUB_API_REQUEST_BUDGET = 100;")
      && worker.includes("const MAX_SCHEDULED_UPSERTS_PER_CYCLE = 0;")
      && productionCycle.includes('actions: []')
      && productionCycle.includes('write_mode: "READ_ONLY_SHADOW"')
      && productionCycle.includes('mutation_authority: "NONE"')
      && productionCycle.includes("writes_allowed: false")
      && !productionCycle.includes("executePlan(")
      && !/node:child_process|\bexecFile\b|\bspawn\b|\bnpm\b|\bimport\s*\(|\brequire\s*\(|\/dispatches|\/rerun/.test(worker),
    "anomaly sentinel worker escaped its read-only production boundary",
  );
  invariant(
    /^import \{ createHash \} from "node:crypto";$/m.test(core)
      && (core.match(/^import /gm) ?? []).length === 1
      && core.includes('"DECOMMISSIONED"')
      && !/node:child_process|\bfetch\s*\(|process\.env|\bimport\s*\(|\brequire\s*\(/.test(core),
    "anomaly sentinel classifier must remain a pure non-network contract",
  );
  let liveness;
  try {
    liveness = JSON.parse(livenessText);
  } catch {
    invariant(false, "anomaly sentinel liveness contract is invalid JSON");
  }
  invariant(
    liveness.schema_version === 2
      && /^[0-9a-f]{40}$/.test(liveness.baseline_ref ?? "")
      && liveness.incident_closure_mode === "quarantine"
      && Array.isArray(liveness.contracts)
      && liveness.contracts.length === 32,
    "anomaly sentinel liveness contract boundary drifted",
  );
  const paths = liveness.contracts.map((item) => item.workflow_path);
  invariant(new Set(paths).size === paths.length, "anomaly sentinel liveness paths are not unique");
  for (const item of liveness.contracts) {
    invariant(/^\.github\/workflows\/[^/]+\.ya?ml$/.test(item.workflow_path ?? ""), "invalid liveness workflow path");
    invariant(/^[0-9a-f]{40}$/.test(item.workflow_blob_sha ?? ""), "invalid liveness workflow blob pin");
    if (item.mode === "scheduled") {
      invariant(
        item.expected_event === "schedule"
          && Number.isSafeInteger(item.recovery_min_successes)
          && item.recovery_min_successes >= 2,
        "scheduled liveness recovery boundary drifted",
      );
    }
  }
  const observer = liveness.contracts.find((item) => item.workflow_path === workflowPath);
  invariant(
    observer?.workflow_name === "Runtime Anomaly Sentinel"
      && observer?.mode === "observer"
      && observer?.workflow_blob_sha === gitBlobSha1(workflow),
    "anomaly sentinel liveness self-pin drifted",
  );
  const publicWorker = liveness.contracts.find(
    (item) => item.workflow_path === PUBLIC_OUTSOURCE_WORKFLOW_PATH,
  );
  const publicCi = liveness.contracts.find(
    (item) => item.workflow_path === PUBLIC_OUTSOURCE_CI_WORKFLOW_PATH,
  );
  invariant(
    publicWorker?.workflow_name === "Public outsource worker"
      && publicWorker?.mode === "event_driven"
      && publicWorker?.workflow_blob_sha === gitBlobSha1(files.get(PUBLIC_OUTSOURCE_WORKFLOW_PATH) ?? "")
      && publicCi?.workflow_name === "Public outsource worker CI"
      && publicCi?.mode === "event_driven"
      && publicCi?.workflow_blob_sha === gitBlobSha1(files.get(PUBLIC_OUTSOURCE_CI_WORKFLOW_PATH) ?? ""),
    "public outsource workflows are not exact-pinned in the liveness registry",
  );
}

function validateGuardWorkflow(workflow) {
  const workflowPath = ".github/workflows/token-cutover-guard-ci.yml";
  invariant(typeof workflow === "string", "token cutover guard workflow is missing");
  const authority = validateWorkflowAuthority(workflow, workflowPath);
  validatePrivilegedExecutionEnvironment(workflow, workflowPath);
  validatePinnedExecutableReferences(
    authority.executableReferences,
    authority.checkoutCredentialDisabledSteps,
    authority.nodeTarget24Steps,
    authority.packageManagerCacheDisabledSteps,
    workflowPath,
  );
  const references = authority.executableReferences.map(({ rawReference }) => {
    const decoded = decodeYamlScalar(rawReference);
    return typeof decoded === "string" ? decoded : rawReference.trim();
  });
  invariant(
    JSON.stringify(references) === JSON.stringify([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    ]),
    "token cutover guard must use only the reviewed Node 24 action runtime closure",
  );
  invariant(
    authority.hasExplicitTopLevelPermissions
      && !authority.hasWriteAuthority
      && JSON.stringify(topLevelChildren(workflow, "permissions")) === JSON.stringify(["contents"]),
    "token cutover guard must remain explicitly read-only",
  );
  invariant(
    workflow.includes("runtime/security/validate_token_cutover.test.mjs")
      && workflow.includes("runtime/continuous-queue/worker.test.mjs")
      && workflow.includes("runtime/security/validate_token_cutover.mjs --root .")
      && workflow.includes("python -m unittest discover -s runtime/kyiv-v3 -p 'test_cdse_*.py' -v"),
    "token cutover guard verification closure drifted",
  );
  invariant(
    gitBlobSha1(workflow) === EXPECTED_GUARD_WORKFLOW_BLOB,
    "token cutover guard workflow exact blob drifted",
  );
}

function validateKnowledgeSkillBusBoundary(files) {
  const workflowPath = ".github/workflows/knowledge-skill-bus-ci.yml";
  const workflow = files.get(workflowPath);
  invariant(typeof workflow === "string", "knowledge/skill bus CI workflow is missing");
  const authority = validateWorkflowAuthority(workflow, workflowPath);
  validatePrivilegedExecutionEnvironment(workflow, workflowPath);
  validatePinnedExecutableReferences(
    authority.executableReferences,
    authority.checkoutCredentialDisabledSteps,
    authority.nodeTarget24Steps,
    authority.packageManagerCacheDisabledSteps,
    workflowPath,
  );
  const references = authority.executableReferences.map(({ rawReference }) => {
    const decoded = decodeYamlScalar(rawReference);
    return typeof decoded === "string" ? decoded : rawReference.trim();
  });
  invariant(
    JSON.stringify(references) === JSON.stringify([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]),
    "knowledge/skill bus CI must use only the reviewed Node 24 action runtime closure",
  );
  invariant(
    authority.hasExplicitTopLevelPermissions
      && !authority.hasWriteAuthority
      && JSON.stringify(topLevelChildren(workflow, "permissions")) === JSON.stringify(["contents"]),
    "knowledge/skill bus CI must remain explicitly read-only",
  );
  invariant(
    JSON.stringify(topLevelChildren(workflow, "on"))
      === JSON.stringify(["pull_request", "workflow_dispatch"]),
    "knowledge/skill bus CI trigger boundary drifted",
  );
  invariant(
    workflow.includes("node --test runtime/knowledge-skill-bus/bus-core.test.mjs")
      && workflow.includes("node runtime/knowledge-skill-bus/canary.mjs"),
    "knowledge/skill bus CI verification closure drifted",
  );

  const worker = files.get("runtime/continuous-queue/worker.mjs");
  invariant(
    !worker.includes("bus_packet_validate")
      && !worker.includes("runBusPacketValidate")
      && !worker.includes("knowledge-skill-bus"),
    "scrapeable public queue must keep inline knowledge/skill packets quarantined",
  );

  for (const [candidatePath, candidateWorkflow] of files) {
    if (!candidatePath.startsWith(".github/workflows/")) continue;
    const triggers = topLevelChildren(candidateWorkflow, "on");
    for (const trigger of triggers) {
      if (!SCRAPEABLE_PUBLIC_INPUT_TRIGGERS.has(trigger)) continue;
      invariant(
        trigger === "issues" && ISSUE_TRIGGER_WORKFLOW_ALLOWLIST.has(candidatePath),
        `scrapeable public-content trigger is not allowlisted: ${candidatePath}:${trigger}`,
      );
    }
    if (candidatePath !== workflowPath) {
      invariant(
        !/knowledge-skill-bus|bus-core|bus_packet_validate/.test(candidateWorkflow),
        `knowledge/skill bus executable reference escaped its exact CI closure: ${candidatePath}`,
      );
    }
  }

  const core = files.get("runtime/knowledge-skill-bus/bus-core.mjs");
  const canary = files.get("runtime/knowledge-skill-bus/canary.mjs");
  invariant(
    /^import \{ createHash \} from "node:crypto";$/m.test(core)
      && (core.match(/^import /gm) ?? []).length === 1
      && !/node:child_process|\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(/.test(core),
    "knowledge/skill bus contract must remain a pure non-network validator",
  );
  invariant(
    /^import assert from "node:assert\/strict";$/m.test(canary)
      && canary.includes('from "./bus-core.mjs"')
      && !/node:child_process|\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(/.test(canary),
    "knowledge/skill bus canary must remain local and non-networked",
  );
}

function validateFixedReadOnlyKsbClosure(files) {
  for (const [sourcePath, expectedBlob] of FIXED_READ_ONLY_KSB_BLOBS) {
    invariant(files.has(sourcePath), `read-only knowledge/skill bus closure is missing: ${sourcePath}`);
    invariant(
      gitBlobSha1(files.get(sourcePath)) === expectedBlob,
      `fixed read-only knowledge/skill bus blob drifted: ${sourcePath}`,
    );
  }
}

function validateSecretContextAccess(workflow, workflowPath) {
  const secretNames = [];
  const expressions = workflow.matchAll(/\$\{\{([\s\S]*?)\}\}/g);
  for (const expression of expressions) {
    const body = expression[1];
    if (!/\bsecrets\b/i.test(body)) continue;
    const namedSecret = body.match(/^\s*secrets\.([A-Z][A-Z0-9_]*)\s*$/);
    invariant(
      namedSecret,
      `whole or computed secret context forbidden: ${workflowPath}`,
    );
    secretNames.push(namedSecret[1]);
  }
  return secretNames;
}

function validatePrivilegedExecutionEnvironment(workflow, workflowPath) {
  const entries = yamlMappingEntries(workflow, workflowPath);
  invariant(
    !entries.some(({ key }) => key === "container" || key === "services"),
    `privileged workflows cannot use job containers or services: ${workflowPath}`,
  );
  const runners = entries.filter(({ key }) => key === "runs-on");
  invariant(runners.length > 0, `privileged workflow has no explicit runner: ${workflowPath}`);
  for (const runner of runners) {
    invariant(
      decodeYamlScalar(runner.value) === "ubuntu-latest",
      `privileged workflow must use the exact GitHub-hosted runner: ${workflowPath}`,
    );
  }
}

function workflowSecretAllowlist(contract) {
  const configured = contract.workflow_secret_allowlist;
  invariant(
    configured && typeof configured === "object" && !Array.isArray(configured),
    "workflow secret allowlist is missing",
  );
  const allowlist = new Map();
  for (const [workflowPath, secretNames] of Object.entries(configured)) {
    invariant(Array.isArray(secretNames) && secretNames.length > 0, `workflow secret allowlist is empty: ${workflowPath}`);
    invariant(contract.workflow_pins?.[workflowPath], `secret-bearing workflow must be identity pinned: ${workflowPath}`);
    const unique = new Set(secretNames);
    invariant(unique.size === secretNames.length, `duplicate workflow secret allowlist entry: ${workflowPath}`);
    for (const secretName of unique) {
      invariant(/^[A-Z][A-Z0-9_]{2,80}$/.test(secretName), `invalid workflow secret allowlist name: ${secretName}`);
    }
    allowlist.set(workflowPath, unique);
  }
  for (const lane of contract.critical_lanes ?? []) {
    const approved = allowlist.get(lane.workflow);
    invariant(approved, `critical lane lacks a workflow secret allowlist: ${lane.workflow}`);
    for (const secretName of lane.replacement_secret_names ?? []) {
      invariant(approved.has(secretName), `replacement secret omitted from its workflow allowlist: ${secretName}`);
    }
  }
  return allowlist;
}

function validateWriteAuthorityPins(contract) {
  for (const authorityScope of WRITE_AUTHORITY_SCOPES) {
    const workflowPath = authorityScope.split("|", 1)[0];
    invariant(contract.workflow_pins?.[workflowPath], `write-authority workflow must be identity pinned: ${workflowPath}`);
  }
}

function validateGlobalWorkflowBoundary(workflows, contract) {
  const legacyName = contract.legacy_secret?.name;
  invariant(legacyName === "COMMAND_CENTER_TOKEN", "legacy secret name changed");
  invariant(
    contract.legacy_secret.same_name_replacement_forbidden === true,
    "same-name legacy replacement must stay forbidden",
  );
  const pins = contract.workflow_pins;
  const allowedLegacy = new Map(
    Object.entries(pins)
      .filter(([, pin]) => pin.legacy_secret_binding_count > 0)
      .map(([workflowPath, pin]) => [workflowPath, pin.legacy_secret_binding_count]),
  );
  const approvedSecrets = workflowSecretAllowlist(contract);
  validateWriteAuthorityPins(contract);
  let actualBindings = 0;
  let actualWorkflows = 0;
  for (const [workflowPath, workflow] of workflows) {
    if (!workflowPath.startsWith(".github/workflows/")) continue;
    const authority = validateWorkflowAuthority(workflow, workflowPath);
    invariant(!/secrets\s*\[/i.test(workflow), `dynamic or bracket secret lookup forbidden: ${workflowPath}`);
    const referencedSecrets = validateSecretContextAccess(workflow, workflowPath);
    for (const secretName of referencedSecrets) {
      invariant(
        approvedSecrets.get(workflowPath)?.has(secretName),
        `workflow secret is not allowlisted: ${workflowPath}:${secretName}`,
      );
    }
    if (referencedSecrets.length > 0 || authority.hasWriteAuthority) {
      validatePrivilegedExecutionEnvironment(workflow, workflowPath);
      validatePinnedExecutableReferences(
        authority.executableReferences,
        authority.checkoutCredentialDisabledSteps,
        authority.nodeTarget24Steps,
        authority.packageManagerCacheDisabledSteps,
        workflowPath,
      );
    }
    invariant(
      authority.hasExplicitTopLevelPermissions,
      `workflow must declare exactly one explicit top-level permissions policy: ${workflowPath}`,
    );
    const count = legacyBindingCount(workflow, legacyName);
    if (count > 0) {
      actualWorkflows += 1;
      actualBindings += count;
      invariant(allowedLegacy.has(workflowPath), `legacy secret added to unapproved workflow: ${workflowPath}`);
      invariant(count === allowedLegacy.get(workflowPath), `legacy secret binding count changed: ${workflowPath}`);
    }
    if (new RegExp(legacyName, "i").test(workflow)) {
      invariant(allowedLegacy.has(workflowPath), `legacy secret alias or literal moved to: ${workflowPath}`);
    }
  }

  const phaseIndex = contract.phase_order.indexOf(contract.phase);
  invariant(phaseIndex >= CONTAIN_PHASE_INDEX, "token cutover phase downgrade forbidden");
  if (contract.phase === "CONTAIN") {
    invariant(actualBindings === 7 && actualWorkflows === 2, "CONTAIN must retain exactly 7 bindings in 2 critical workflows");
    invariant(contract.legacy_secret.current_binding_count === 7, "contract legacy binding count drifted");
    invariant(contract.legacy_secret.current_workflow_count === 2, "contract legacy workflow count drifted");
  } else {
    invariant(actualBindings === 0 && actualWorkflows === 0, `${contract.phase} requires zero legacy bindings`);
    invariant(contract.legacy_secret.current_binding_count === 0, `${contract.phase} contract count must be zero`);
    invariant(contract.legacy_secret.current_workflow_count === 0, `${contract.phase} workflow count must be zero`);
  }

  const owners = replacementSecretOwners(contract);
  for (const [secretName, ownerWorkflow] of owners) {
    for (const [workflowPath, workflow] of workflows) {
      if (new RegExp(`\\b${secretName}\\b`).test(workflow)) {
        invariant(workflowPath === ownerWorkflow, `${secretName} escaped its owning lane`);
      }
    }
  }
}

function validateKyivWorkflow(workflow, contract) {
  invariant(
    JSON.stringify(topLevelChildren(workflow, "on")) === JSON.stringify(["schedule"]),
    "Kyiv secret-bearing trigger must be default-branch schedule-only",
  );
  invariant(!/if:\s*always\(\)/i.test(workflow), "Kyiv secret-bearing step may not use always()");
  invariant(!/github\.event_name\s*==\s*["']push["']/i.test(workflow), "Kyiv push bootstrap must stay removed");
  invariant(
    JSON.stringify(topLevelChildren(workflow, "permissions")) === JSON.stringify(["contents"])
      && JSON.stringify(topLevelChildren(workflow, "jobs")) === JSON.stringify(["fast-watch"])
      && workflow.includes("if: github.event_name == 'schedule'")
      && !workflow.includes("actions: write")
      && !workflow.includes("/actions/workflows/kyiv-fast-watch.yml/dispatches"),
    "Kyiv must use one read-only scheduled job without self-dispatch",
  );
  invariant(/id:\s*fast_watch_tests/.test(workflow), "Kyiv regression gate needs a stable step id");
  invariant(
    workflow.includes("if: ${{ !cancelled() && steps.fast_watch_tests.outcome == 'success' }}"),
    "Kyiv degraded readback must require trusted tests without requiring runtime success",
  );
  invariant(
    workflow.includes("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"),
    "Kyiv checkout action must use the reviewed Node 24 runtime pin",
  );
  invariant(
    workflow.includes("actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97"),
    "Kyiv Python action must use the reviewed Node 24 runtime pin",
  );
  invariant(
    (workflow.match(/persist-credentials:\s*false/g) ?? []).length === 1
      && !/persist-credentials:\s*true/i.test(workflow),
    "Kyiv checkout must not persist credentials",
  );
  const privatePin = contract.private_code_pins?.[".github/workflows/kyiv-fast-watch.yml"];
  invariant(privatePin?.repository === "ragrardannekjold/jarvis-command-center", "Kyiv private repository pin drifted");
  invariant(/^[0-9a-f]{40}$/.test(privatePin?.commit ?? ""), "Kyiv private commit pin is invalid");
  invariant(workflow.includes(`ref: ${privatePin.commit}`), "Kyiv private checkout must use the exact reviewed commit");
  invariant(!/\n\s*ref:\s*main\s*$/mi.test(workflow), "Kyiv private checkout cannot track mutable main");
}

function validateExposureWorkflow(workflow) {
  invariant(
    JSON.stringify(topLevelChildren(workflow, "on")) === JSON.stringify(["schedule"]),
    "Exposure secret-bearing trigger must be default-branch schedule-only",
  );
  invariant(
    JSON.stringify(topLevelChildren(workflow, "jobs")) === JSON.stringify(["boundary-tests", "passive-read"]),
    "Exposure must separate unprivileged tests from the privileged worker job",
  );
  invariant(
    workflow.includes("needs: boundary-tests")
      && (workflow.match(/needs\.boundary-tests\.result == 'success'/g) ?? []).length === 2
      && workflow.includes("github.event_name == 'schedule'"),
    "Exposure secret-bearing execution must require the isolated boundary-test job",
  );
  invariant(/id:\s*runtime_checkout/.test(workflow), "Exposure privileged checkout needs a stable gate id");
  invariant(/id:\s*runtime_node/.test(workflow), "Exposure privileged runtime setup needs a stable gate id");
  invariant(
    workflow.includes("if: ${{ !cancelled() && needs.boundary-tests.result == 'success' && steps.runtime_checkout.outcome == 'success' && steps.runtime_node.outcome == 'success' }}"),
    "Investigation must require successful privileged checkout and runtime setup",
  );
  invariant(!/if:\s*always\(\)/i.test(workflow), "Exposure secret-bearing step may not bypass failed tests");
  invariant(
    workflow.includes("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"),
    "Exposure checkout action must use the reviewed Node 24 runtime pin",
  );
  invariant(
    (workflow.match(/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/g) ?? []).length === 2
      && (workflow.match(/node-version:\s*'24'/g) ?? []).length === 2
      && (workflow.match(/package-manager-cache:\s*false/g) ?? []).length === 2,
    "Exposure Node steps must use the reviewed Node 24 target and action runtime",
  );
  invariant(
    (workflow.match(/persist-credentials:\s*false/g) ?? []).length === 2
      && !/persist-credentials:\s*true/i.test(workflow),
    "Exposure checkout must not persist credentials",
  );
}

function validateCdseWorkflow(workflow) {
  invariant(
    JSON.stringify(topLevelChildren(workflow, "on")) === JSON.stringify(["schedule"]),
    "CDSE secret-bearing trigger must be default-branch schedule-only",
  );
  invariant(
    JSON.stringify(topLevelChildren(workflow, "permissions")) === JSON.stringify(["contents"]),
    "CDSE top-level permissions must stay read-only",
  );
  invariant(
    JSON.stringify(topLevelChildren(workflow, "jobs")) === JSON.stringify(["validate", "drain"]),
    "CDSE must separate read-only validation from privileged draining",
  );
  invariant(
    (workflow.match(/actions:\s*write/gi) ?? []).length === 1
      && workflow.includes("    permissions:\n      contents: read\n      actions: write"),
    "CDSE collector dispatch authority must exist only on the drain job",
  );
  invariant(
    workflow.includes("needs: validate")
      && workflow.includes("needs.validate.result == 'success'")
      && workflow.includes("github.event_name == 'schedule'")
      && !workflow.includes("workflow_dispatch"),
    "CDSE drain must require successful validation and the scheduled runtime event",
  );
  const drainSection = workflow.slice(workflow.indexOf("\n  drain:"));
  invariant(/\n    timeout-minutes:\s*5\s*$/m.test(drainSection), "CDSE drain timeout must retain the five-minute runtime budget");
  invariant(
    workflow.includes("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"),
    "CDSE checkout action must use the reviewed Node 24 runtime pin",
  );
  invariant(
    workflow.includes("actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97"),
    "CDSE Python action must use the reviewed Node 24 runtime pin",
  );
  invariant(
    (workflow.match(/persist-credentials:\s*false/g) ?? []).length === 2
      && !/persist-credentials:\s*true/i.test(workflow),
    "CDSE checkout must not persist credentials",
  );
}

function validateCdseSources(files) {
  const queue = files.get("runtime/kyiv-v3/cdse_event_queue.py");
  const delta = files.get("runtime/kyiv-v3/cdse_public_delta.py");
  invariant(/^WORKFLOW = "kyiv-v3-public-collector\.yml"$/m.test(queue), "CDSE dispatch target must stay the public collector");
  invariant(
    queue.includes("/actions/workflows/{WORKFLOW}/dispatches"),
    "CDSE credentialed path must use the fixed workflow-dispatch endpoint",
  );
  invariant(
    delta.includes("q.dispatch_refresh(github_token, repository)"),
    "CDSE public-delta path must dispatch through the pinned target helper",
  );
}

export function validateAttestation(contract) {
  const attestation = contract.external_attestation;
  invariant(attestation && typeof attestation === "object", "external attestation state is missing");
  if (contract.phase === "ENFORCED") {
    invariant(attestation.status === "VERIFIED", "ENFORCED requires verified external attestation");
    invariant(/^[0-9a-f]{64}$/.test(attestation.artifact_sha256 ?? ""), "ENFORCED attestation digest is invalid");
    invariant(contract.legacy_secret.repository_secret_removal === "VERIFIED", "legacy secret removal is not verified");
    invariant(contract.legacy_secret.underlying_credential_revocation === "VERIFIED", "legacy credential revocation is not verified");
  } else {
    invariant(attestation.status === "PENDING_EXTERNAL_AUTHORITY", "pre-enforcement attestation state must stay pending");
  }
}

function validatePublicManifest(manifest, contract) {
  invariant(manifest && typeof manifest === "object", "public export manifest is missing");
  invariant(
    manifest.status === "SHARED_TOKEN_CONTAINMENT_ACTIVE_CUTOVER_PENDING",
    "public manifest containment status drifted",
  );
  invariant(manifest.bridge_secret_required === contract.legacy_secret.name, "public manifest legacy secret name drifted");
  invariant(
    manifest.bridge_secret_scope === "CURRENT_DEFAULT_BRANCH_REFERENCES_IN_TWO_WORKFLOWS",
    "public manifest must describe references, not unverified secret-registry isolation",
  );
  const cutover = manifest.token_cutover;
  invariant(cutover?.phase === contract.phase, "public manifest cutover phase drifted");
  invariant(cutover?.manual_token_workflows_disabled === 6, "public manifest manual containment count drifted");
  invariant(
    cutover?.manual_secret_bearing_dispatch === "DISABLED_PENDING_PROTECTED_ENVIRONMENT_ATTESTATION"
      && cutover?.default_branch_schedule_only_secret_workflows === 4,
    "public manifest selected-ref secret boundary drifted",
  );
  invariant(cutover?.scheduled_critical_workflows_retained === 2, "public manifest critical workflow count drifted");
  invariant(
    cutover?.current_legacy_secret_bindings === contract.legacy_secret.current_binding_count,
    "public manifest legacy binding count drifted",
  );
  invariant(
    cutover?.repository_secret_registry_isolation === "NOT_VERIFIED_ALL_WORKFLOWS_MUST_BE_TREATED_AS_ELIGIBLE",
    "public manifest overclaims repository-secret isolation",
  );
  invariant(
    cutover?.historical_rerun_capability === contract.legacy_secret.historical_rerun_capability,
    "public manifest historical rerun state drifted",
  );
  invariant(cutover?.same_name_secret_replacement_allowed === false, "public manifest allows same-name replacement");
  invariant(
    cutover?.external_secret_and_revocation_attestation === contract.external_attestation.status,
    "public manifest external attestation state drifted",
  );
  const bus = manifest.knowledge_skill_bus;
  invariant(
    bus?.status === "CONTRACT_CANARY_READY_PUBLIC_QUEUE_ROUTE_QUARANTINED"
      && bus?.schema_version === 1
      && bus?.enabled_job_type === null
      && bus?.module_accepts_public_packets_only === true
      && bus?.public_issue_transport_enabled === false
      && bus?.public_issue_bodies_treated_as_scrapeable === true
      && bus?.scrape_resistant_private_transport_required === true
      && bus?.arbitrary_command_or_url_execution === false
      && bus?.private_transport_enabled === false
      && bus?.autonomous_production_promotion === false
      && bus?.hostile_observation_absence_claimed === false
      && bus?.historical_public_canary?.issue_number === 278
      && bus?.historical_public_canary?.queue_run_id === 32949269297
      && bus?.historical_public_canary?.state_claim === "SUCCEEDED"
      && bus?.historical_public_canary?.accepted_claim === true
      && bus?.historical_public_canary?.detected_gap === "bus.private_transport"
      && bus?.historical_public_canary?.security_attestation_accepted === false
      && bus?.historical_public_canary?.legacy_v1_public_transport_now_quarantined === true,
    "public manifest knowledge/skill bus quarantine boundary drifted",
  );
  const anomaly = manifest.runtime_anomaly_sentinel;
  invariant(
    anomaly?.status === "PRODUCTION_READ_ONLY_SHADOW_AWAITING_LIVE_READBACK"
      && anomaly?.schema_version === 2
      && anomaly?.source === "github_actions_public_metadata"
      && anomaly?.schedule === "ten_minute_read_only_shadow"
      && anomaly?.observer_request_budget_per_cycle === 100
      && anomaly?.max_scheduled_issue_upserts_per_cycle === 0
      && anomaly?.active_failure_dedupe === true
      && anomaly?.scheduled_liveness_upserts_enabled === false
      && anomaly?.write_mode === "READ_ONLY_SHADOW"
      && anomaly?.mutation_authority === "NONE"
      && anomaly?.execution_issue_upserts_enabled === false
      && anomaly?.execution_history_complete === false
      && anomaly?.api_orphaned_active_workflows_fail_health === true
      && anomaly?.historical_rerun_surface_neutralized === false
      && anomaly?.recovery_closes_incident === false
      && anomaly?.incident_closure_mode === "QUARANTINE_PENDING_HISTORICAL_RERUN_NEUTRALIZATION"
      && anomaly?.certified_green_available === false
      && anomaly?.minimum_reported_state === "AMBER"
      && anomaly?.expected_cancellation_separate === true
      && anomaly?.rerun_or_repair_authority === false
      && anomaly?.mailbox_content_read === false
      && anomaly?.private_content_publication === false
      && anomaly?.historical_main_canary_not_candidate_evidence?.run_id === 32969965585,
    "public manifest anomaly sentinel read-only shadow boundary drifted",
  );
  invariant(manifest.command_center_runtime_schedule_enabled === false, "disabled command runtime cannot claim a schedule");
  invariant(manifest.daily_report_schedule?.enabled === false, "disabled daily report cannot claim a schedule");
  invariant(
    manifest.daily_report_schedule?.commit_triggered_verification_available === false,
    "disabled daily report cannot claim commit-triggered verification",
  );
  invariant(
    manifest.exposure_lookup?.commit_triggered_verification_available === false,
    "Exposure cannot claim a removed push trigger",
  );
  const requiredAllowlist = [
    ".github/workflows/kyiv-fast-watch.yml",
    ".github/workflows/exposure-intelligence.yml",
    ".github/workflows/token-cutover-guard-ci.yml",
    ".github/workflows/knowledge-skill-bus-ci.yml",
    "runtime/security/token_cutover_contract.json",
    "runtime/security/validate_token_cutover.mjs",
    "runtime/security/validate_token_cutover.test.mjs",
    "runtime/kyiv-v3/test_cdse_event_queue.py",
    "runtime/kyiv-v3/test_cdse_public_delta.py",
    "runtime/persist_ai39_cdse_cache.py",
    "runtime/continuous-queue/worker.test.mjs",
    "runtime/knowledge-skill-bus/README.md",
    "runtime/knowledge-skill-bus/bus-core.mjs",
    "runtime/knowledge-skill-bus/bus-core.test.mjs",
    "runtime/knowledge-skill-bus/canary.mjs",
  ];
  requiredAllowlist.push(...contract.manual_tombstones.map((spec) => spec.path));
  requiredAllowlist.push(...Object.keys(contract.workflow_pins));
  requiredAllowlist.push(...Object.keys(contract.privileged_source_pins));
  requiredAllowlist.push(...PUBLIC_OUTSOURCE_EXPORT_PATHS);
  invariant(Array.isArray(manifest.allowlist), "public manifest allowlist is missing");
  for (const requiredPath of requiredAllowlist) {
    invariant(manifest.allowlist.includes(requiredPath), `public manifest omits ${requiredPath}`);
  }
}

export function validateSnapshot(workflows, contract, manifest = undefined) {
  invariant(contract.schema_version === 1, "unsupported token cutover contract version");
  invariant(Array.isArray(contract.phase_order), "phase order is missing");
  validateManualTombstones(workflows, contract);
  validatePinnedWorkflows(workflows, contract);
  validatePinnedSources(workflows, contract);
  validatePrivilegedLocalExecutionClosure(workflows, contract);
  validateGlobalWorkflowBoundary(workflows, contract);
  validatePublicOutsourceBoundary(workflows, contract);
  validateAnomalySentinelBoundary(workflows);
  validateGuardWorkflow(workflows.get(".github/workflows/token-cutover-guard-ci.yml"));
  validateFixedReadOnlyKsbClosure(workflows);
  validateKnowledgeSkillBusBoundary(workflows);
  validateFixedLocalExecutionBlobs(workflows, contract);
  validateKyivWorkflow(workflows.get(".github/workflows/kyiv-fast-watch.yml"), contract);
  validateExposureWorkflow(workflows.get(".github/workflows/exposure-intelligence.yml"));
  validateCdseWorkflow(workflows.get(".github/workflows/kyiv-cdse-event-queue.yml"));
  validateCdseSources(workflows);
  validateAttestation(contract);
  if (manifest !== undefined) validatePublicManifest(manifest, contract);
  return {
    status: "PASS",
    phase: contract.phase,
    legacy_secret_bindings: contract.legacy_secret.current_binding_count,
    legacy_secret_workflows: contract.legacy_secret.current_workflow_count,
    manual_tombstones: contract.manual_tombstones.length,
    privileged_source_pins: Object.keys(contract.privileged_source_pins).length,
    historical_rerun_capability: contract.legacy_secret.historical_rerun_capability,
    external_attestation: contract.external_attestation.status,
  };
}

export async function loadSnapshot(root) {
  const contractBytes = await readFile(path.join(root, CONTRACT_PATH));
  invariant(sha256(contractBytes) === EXPECTED_CONTRACT_SHA256, "token cutover contract identity changed");
  const contract = JSON.parse(contractBytes.toString("utf8"));
  const manifest = JSON.parse(
    await readFile(path.join(root, MANIFEST_PATH), "utf8"),
  );
  const workflowDirectory = path.join(root, ".github/workflows");
  const filenames = (await readdir(workflowDirectory))
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  const workflows = new Map();
  for (const filename of filenames) {
    workflows.set(
      `.github/workflows/${filename}`,
      await readFile(path.join(workflowDirectory, filename), "utf8"),
    );
  }
  for (const sourcePath of Object.keys(contract.privileged_source_pins ?? {})) {
    workflows.set(sourcePath, await readFile(path.join(root, sourcePath), "utf8"));
  }
  for (const sourcePath of FIXED_READ_ONLY_KSB_BLOBS.keys()) {
    if (sourcePath.startsWith(".github/workflows/")) continue;
    workflows.set(sourcePath, await readFile(path.join(root, sourcePath), "utf8"));
  }
  return { workflows, contract, manifest };
}

export async function validateRoot(root) {
  const snapshot = await loadSnapshot(root);
  return validateSnapshot(snapshot.workflows, snapshot.contract, snapshot.manifest);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootIndex = process.argv.indexOf("--root");
  const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : ".");
  try {
    process.stdout.write(`${JSON.stringify(await validateRoot(root), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`TOKEN_CUTOVER_GUARD_FAIL:${error.message}\n`);
    process.exitCode = 1;
  }
}
