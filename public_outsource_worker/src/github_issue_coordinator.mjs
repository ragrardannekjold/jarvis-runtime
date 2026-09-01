import { sha256Object, stableStringify } from "./canonical.mjs";
import { WorkerError, fail } from "./errors.mjs";
import {
  assertExactKeys,
  assertPlainObject,
  validateEnvelope,
} from "./security.mjs";

export const ISSUE_TITLE_PREFIX = "[OUTSOURCE-TASK] ";
export const ISSUE_SCHEMA = "public.outsource_issue.v1";
export const TERMINAL_SCHEMA = "public.outsource_issue_result.v1";
export const TERMINAL_BEGIN = "<!-- OUTSOURCE_RESULT_V1\n";
export const TERMINAL_END = "\nOUTSOURCE_RESULT_V1_END -->";

const SHA256 = /^[0-9a-f]{64}$/;

function validateNext(next, envelope) {
  if (next === null) return;
  assertExactKeys(next, ["capability", "worker"], "INVALID_NEXT");
  if (
    envelope.worker !== "cuckoo" ||
    envelope.capability !== "prozorro_snapshot_v1" ||
    next.worker !== "bubo" ||
    next.capability !== "evidence_packet_v1"
  ) {
    fail("INVALID_NEXT", "Only Cuckoo to BUBO public evidence chaining is allowed");
  }
}

function validateDependency(dependency, envelope) {
  if (dependency === null) {
    if (envelope.worker === "bubo") {
      fail("MISSING_DEPENDENCY", "BUBO issue requires a prior terminal result");
    }
    return;
  }
  assertExactKeys(
    dependency,
    ["issue_number", "result_sha256", "task_id"],
    "INVALID_DEPENDENCY",
  );
  if (
    envelope.worker !== "bubo" ||
    envelope.capability !== "evidence_packet_v1" ||
    !Number.isSafeInteger(dependency.issue_number) ||
    dependency.issue_number <= 0 ||
    typeof dependency.task_id !== "string" ||
    !SHA256.test(dependency.result_sha256)
  ) {
    fail("INVALID_DEPENDENCY", "Dependency is not a valid Cuckoo terminal reference");
  }
  assertExactKeys(envelope.payload, [], "INVALID_DEPENDENCY_PAYLOAD");
}

export function validateIssueDescriptor(input) {
  assertExactKeys(
    input,
    ["depends_on", "envelope", "next", "schema"],
    "INVALID_ISSUE_DESCRIPTOR",
  );
  if (input.schema !== ISSUE_SCHEMA) {
    fail("INVALID_ISSUE_DESCRIPTOR", `Expected schema=${ISSUE_SCHEMA}`);
  }
  const envelope = validateEnvelope(input.envelope);
  validateNext(input.next, envelope);
  validateDependency(input.depends_on, envelope);
  return structuredClone(input);
}

export function parseOwnerTaskIssue(event, { generatedBotLogin = null } = {}) {
  assertPlainObject(event, "INVALID_ISSUE_EVENT");
  if (event.action !== "opened") {
    fail("ISSUE_ACTION_REJECTED", "Only newly opened task issues are accepted");
  }
  if (event.repository?.private !== false) {
    fail("REPOSITORY_NOT_PUBLIC", "Public worker accepts events only from a public repository");
  }
  if (
    typeof event.issue?.number !== "number" ||
    typeof event.issue?.title !== "string" ||
    typeof event.issue?.body !== "string" ||
    !event.issue.title.startsWith(ISSUE_TITLE_PREFIX)
  ) {
    fail("INVALID_ISSUE_EVENT", "Issue is not an OUTSOURCE-TASK contract");
  }

  let descriptor;
  try {
    descriptor = JSON.parse(event.issue.body);
  } catch {
    fail("INVALID_ISSUE_BODY", "Issue body must be the exact JSON descriptor");
  }
  descriptor = validateIssueDescriptor(descriptor);
  const ownerLogin = event.repository?.owner?.login;
  const authorLogin = event.issue?.user?.login;
  const ownerCreated = Boolean(ownerLogin && authorLogin === ownerLogin);
  const coordinatorGeneratedBubo = Boolean(
    generatedBotLogin &&
      authorLogin === generatedBotLogin &&
      descriptor.envelope.worker === "bubo" &&
      descriptor.envelope.capability === "evidence_packet_v1" &&
      descriptor.depends_on,
  );
  if (!ownerCreated && !coordinatorGeneratedBubo) {
    fail(
      "ISSUE_AUTHOR_REJECTED",
      "Task issue must be owner-created or a provenance-pinned BUBO child created by the configured bot",
    );
  }
  if (event.issue.title !== `${ISSUE_TITLE_PREFIX}${descriptor.envelope.task_id}`) {
    fail("ISSUE_TITLE_MISMATCH", "Issue title must end with the exact task_id");
  }
  return descriptor;
}

export function createTerminal(result) {
  assertPlainObject(result, "INVALID_DISPATCH_RESULT");
  const core = {
    schema: TERMINAL_SCHEMA,
    task_id: result.task_id,
    case_id: result.case_id,
    worker: result.worker,
    capability: result.capability,
    result,
  };
  return { ...core, result_sha256: sha256Object(core) };
}

export function formatTerminalComment(terminal) {
  validateTerminal(terminal);
  return `${TERMINAL_BEGIN}${stableStringify(terminal)}${TERMINAL_END}`;
}

export function validateTerminal(input) {
  assertExactKeys(
    input,
    [
      "capability",
      "case_id",
      "result",
      "result_sha256",
      "schema",
      "task_id",
      "worker",
    ],
    "INVALID_TERMINAL",
  );
  if (input.schema !== TERMINAL_SCHEMA || !SHA256.test(input.result_sha256)) {
    fail("INVALID_TERMINAL", "Terminal result schema or hash is invalid");
  }
  const { result_sha256: expected, ...core } = input;
  if (sha256Object(core) !== expected) {
    fail("TERMINAL_HASH_MISMATCH", "Terminal result has been modified");
  }
  if (
    core.result.task_id !== core.task_id ||
    core.result.case_id !== core.case_id ||
    core.result.worker !== core.worker ||
    core.result.capability !== core.capability ||
    core.result.sensitivity !== "PUBLIC"
  ) {
    fail("INVALID_TERMINAL", "Terminal metadata does not match its result");
  }
  return structuredClone(input);
}

export function parseBotTerminalComment(comment, botLogin) {
  if (comment?.user?.login !== botLogin || typeof comment?.body !== "string") {
    fail("UNTRUSTED_TERMINAL_AUTHOR", "Terminal comment is not from the configured bot");
  }
  if (
    !comment.body.startsWith(TERMINAL_BEGIN) ||
    !comment.body.endsWith(TERMINAL_END) ||
    comment.body.indexOf(TERMINAL_BEGIN, TERMINAL_BEGIN.length) !== -1
  ) {
    fail("INVALID_TERMINAL_MARKER", "Terminal comment marker is missing or ambiguous");
  }
  const raw = comment.body.slice(TERMINAL_BEGIN.length, -TERMINAL_END.length);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("INVALID_TERMINAL", "Terminal marker does not contain valid JSON");
  }
  return validateTerminal(parsed);
}

export function findCurrentTerminal(comments, taskId, botLogin) {
  const terminals = [];
  for (const comment of comments ?? []) {
    if (
      comment?.user?.login !== botLogin ||
      typeof comment?.body !== "string" ||
      !comment.body.startsWith(TERMINAL_BEGIN)
    ) {
      continue;
    }
    const terminal = parseBotTerminalComment(comment, botLogin);
    if (terminal.task_id === taskId) terminals.push(terminal);
  }
  if (terminals.length === 0) return null;
  const hashes = new Set(terminals.map((item) => item.result_sha256));
  if (hashes.size !== 1) {
    fail("CONFLICTING_TERMINALS", "Multiple different terminal results exist for task");
  }
  return terminals[0];
}

export function resolveRuntimeEnvelope(descriptor, priorComments, botLogin) {
  const validated = validateIssueDescriptor(descriptor);
  if (validated.envelope.worker !== "bubo") return validated.envelope;

  const dependency = validated.depends_on;
  const prior = findCurrentTerminal(priorComments, dependency.task_id, botLogin);
  if (!prior) {
    fail("DEPENDENCY_NOT_READY", "Referenced Cuckoo terminal result is not available");
  }
  if (prior.result_sha256 !== dependency.result_sha256) {
    fail("DEPENDENCY_HASH_MISMATCH", "Referenced terminal hash does not match issue");
  }
  if (
    prior.worker !== "cuckoo" ||
    prior.capability !== "prozorro_snapshot_v1" ||
    prior.result.result?.schema !== "public.prozorro_snapshot.v1"
  ) {
    fail("DEPENDENCY_CAPABILITY_MISMATCH", "BUBO dependency is not a Cuckoo snapshot");
  }

  return {
    ...validated.envelope,
    payload: { cuckoo_result: prior.result.result },
  };
}

function childTaskId(parentTaskId) {
  const candidate = `${parentTaskId}.bubo`;
  if (candidate.length <= 128) return candidate;
  return `bubo.${sha256Object(parentTaskId).slice(0, 32)}`;
}

export function planNextIssue({
  descriptor,
  issueNumber,
  terminal,
  existingIssues = [],
}) {
  const validated = validateIssueDescriptor(descriptor);
  const checkedTerminal = validateTerminal(terminal);
  if (validated.next === null) return null;
  if (
    checkedTerminal.task_id !== validated.envelope.task_id ||
    checkedTerminal.worker !== "cuckoo"
  ) {
    fail("NEXT_SOURCE_MISMATCH", "Next issue source does not match Cuckoo task");
  }

  const taskId = childTaskId(validated.envelope.task_id);
  const child = {
    schema: ISSUE_SCHEMA,
    envelope: {
      task_id: taskId,
      case_id: validated.envelope.case_id,
      worker: "bubo",
      capability: "evidence_packet_v1",
      sensitivity: "PUBLIC",
      payload: {},
    },
    next: null,
    depends_on: {
      issue_number: issueNumber,
      task_id: checkedTerminal.task_id,
      result_sha256: checkedTerminal.result_sha256,
    },
  };
  validateIssueDescriptor(child);
  const planned = {
    title: `${ISSUE_TITLE_PREFIX}${taskId}`,
    body: JSON.stringify(child, null, 2),
  };

  for (const issue of existingIssues) {
    if (issue?.title !== planned.title) continue;
    if (issue.body === planned.body) return null;
    fail("NEXT_ISSUE_CONFLICT", "Deterministic BUBO issue title already has different body");
  }
  return planned;
}

export async function coordinateIssueTask({
  event,
  dispatcher,
  botLogin,
  existingComments = [],
  priorComments = [],
  existingIssues = [],
}) {
  const descriptor = parseOwnerTaskIssue(event, { generatedBotLogin: botLogin });
  const taskId = descriptor.envelope.task_id;
  const terminal = findCurrentTerminal(existingComments, taskId, botLogin);
  if (terminal) {
    return {
      action: "NOOP_ALREADY_TERMINAL",
      terminal,
      comment_body: null,
      next_issue: planNextIssue({
        descriptor,
        issueNumber: event.issue.number,
        terminal,
        existingIssues,
      }),
    };
  }

  const runtimeEnvelope = resolveRuntimeEnvelope(
    descriptor,
    priorComments,
    botLogin,
  );
  const result = await dispatcher.dispatch(runtimeEnvelope);
  const newTerminal = createTerminal(result);
  return {
    action: "COMMENT_TERMINAL",
    terminal: newTerminal,
    comment_body: formatTerminalComment(newTerminal),
    next_issue: planNextIssue({
      descriptor,
      issueNumber: event.issue.number,
      terminal: newTerminal,
      existingIssues,
    }),
  };
}

export function isCoordinatorError(error, code) {
  return error instanceof WorkerError && error.code === code;
}
