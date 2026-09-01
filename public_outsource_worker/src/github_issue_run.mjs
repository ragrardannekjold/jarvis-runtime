import { fail } from "./errors.mjs";
import {
  childTaskId,
  coordinateIssueTask,
  createTerminal,
  findCurrentTerminal,
  findUniqueTaskIssue,
  formatTerminalComment,
  parseBotTerminalComment,
  parseOwnerTaskIssue,
  planNextIssue,
  resolveRuntimeEnvelope,
  validateIssueDescriptor,
} from "./github_issue_coordinator.mjs";

function assertGithubPort(github) {
  for (const method of [
    "taskIssues",
    "comments",
    "comment",
    "createIssue",
    "lockIssue",
  ]) {
    if (typeof github?.[method] !== "function") {
      fail("INVALID_GITHUB_PORT", `GitHub port is missing method ${method}`);
    }
  }
}

function parseDescriptorBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail("INVALID_ISSUE_BODY", "Generated child issue body is not valid JSON");
  }
  return validateIssueDescriptor(parsed);
}

// This is intentionally a two-stage, non-recursive state machine. A single
// invocation can execute at most one Cuckoo adapter and one BUBO adapter.
// GitHub issue history is the recovery log between fresh runner processes.
export async function runBoundedIssueChain({
  event,
  dispatcher,
  botLogin,
  github,
}) {
  assertGithubPort(github);
  const rootDescriptor = parseOwnerTaskIssue(event);
  if (
    rootDescriptor.envelope.worker !== "cuckoo" ||
    rootDescriptor.envelope.capability !== "prozorro_snapshot_v1"
  ) {
    fail("INVALID_ROOT_CAPABILITY", "Owner workflow must start with a Cuckoo snapshot task");
  }

  // Lock before any history read so public comments cannot consume the recovery
  // pagination budget or race a trusted terminal.
  await github.lockIssue(event.issue.number);
  const taskId = rootDescriptor.envelope.task_id;
  const ownerLogin = event.repository.owner.login;
  const [rootIssues, preexistingChildIssues] = await Promise.all([
    github.taskIssues(taskId, ownerLogin),
    rootDescriptor.next === null
      ? Promise.resolve([])
      : github.taskIssues(childTaskId(taskId), botLogin),
  ]);
  if (!Array.isArray(rootIssues) || !Array.isArray(preexistingChildIssues)) {
    fail("INVALID_ISSUE_INDEX", "GitHub issue index must be an array");
  }
  const existingIssues = [...rootIssues, ...preexistingChildIssues];
  const parentComments = await github.comments(event.issue.number);
  const parentDecision = await coordinateIssueTask({
    event,
    dispatcher,
    botLogin,
    existingComments: parentComments,
    existingIssues,
  });

  let adapterExecutions = parentDecision.comment_body ? 1 : 0;
  const parentHistory = [...parentComments];
  if (parentDecision.comment_body) {
    const posted = await github.comment(
      event.issue.number,
      parentDecision.comment_body,
    );
    const verified = parseBotTerminalComment(posted, botLogin);
    if (verified.result_sha256 !== parentDecision.terminal.result_sha256) {
      fail("POSTED_TERMINAL_MISMATCH", "GitHub returned a different parent terminal");
    }
    parentHistory.push(posted);
  }

  const summary = {
    schema: "public.outsource_bounded_run.v1",
    adapter_executions: adapterExecutions,
    parent: {
      issue_number: event.issue.number,
      task_id: parentDecision.terminal.task_id,
      action: parentDecision.action,
      result_sha256: parentDecision.terminal.result_sha256,
    },
    child: null,
  };
  if (rootDescriptor.next === null) return summary;

  // Build the deterministic child independently of current index state. This
  // lets a rerun resume an already-created child that has no terminal comment.
  const childPlan = planNextIssue({
    descriptor: rootDescriptor,
    issueNumber: event.issue.number,
    terminal: parentDecision.terminal,
    existingIssues: [],
    generatedByLogin: botLogin,
  });
  const childDescriptor = parseDescriptorBody(childPlan.body);
  const childId = childDescriptor.envelope.task_id;
  const freshIssues = await github.taskIssues(childId, botLogin);
  if (!Array.isArray(freshIssues)) {
    fail("INVALID_ISSUE_INDEX", "GitHub issue index must be an array");
  }
  let childIssue = findUniqueTaskIssue(freshIssues, childId, botLogin);
  let childCreated = false;
  if (childIssue) {
    if (childIssue.body !== childPlan.body) {
      fail("NEXT_ISSUE_CONFLICT", "Existing deterministic BUBO issue has different body");
    }
  } else {
    const created = await github.createIssue(childPlan);
    if (!Number.isSafeInteger(created?.number) || created.number <= 0) {
      fail("INVALID_CREATED_ISSUE", "GitHub did not return a positive child issue number");
    }
    if (
      (created.title !== undefined && created.title !== childPlan.title) ||
      (created.body !== undefined && created.body !== childPlan.body) ||
      created.user?.login !== botLogin
    ) {
      fail("INVALID_CREATED_ISSUE", "Created issue does not match deterministic child plan");
    }
    childIssue = { number: created.number, ...childPlan };
    childCreated = true;

    const afterCreateIssues = await github.taskIssues(childId, botLogin);
    if (!Array.isArray(afterCreateIssues)) {
      fail("INVALID_ISSUE_INDEX", "GitHub issue index must be an array");
    }
    const authoritative = findUniqueTaskIssue(
      afterCreateIssues,
      childId,
      botLogin,
    );
    if (!authoritative || authoritative.number !== childIssue.number) {
      fail(
        "CREATED_CHILD_NOT_AUTHORITATIVE",
        "Created child is not the unique bot-authored task issue",
      );
    }
  }

  await github.lockIssue(childIssue.number);
  const childComments = await github.comments(childIssue.number);
  // Always resolve the dependency, even if a child terminal exists, so case,
  // capability, parent author, and parent hash are revalidated on every rerun.
  const buboEnvelope = resolveRuntimeEnvelope(
    childDescriptor,
    parentHistory,
    botLogin,
  );
  let childTerminal = findCurrentTerminal(childComments, childId, botLogin);
  let childAction = "NOOP_ALREADY_TERMINAL";
  if (!childTerminal) {
    const childResult = await dispatcher.dispatch(buboEnvelope);
    childTerminal = createTerminal(childResult);
    const posted = await github.comment(
      childIssue.number,
      formatTerminalComment(childTerminal),
    );
    const verified = parseBotTerminalComment(posted, botLogin);
    if (verified.result_sha256 !== childTerminal.result_sha256) {
      fail("POSTED_TERMINAL_MISMATCH", "GitHub returned a different child terminal");
    }
    childAction = "COMMENT_TERMINAL";
    adapterExecutions += 1;
  }

  summary.adapter_executions = adapterExecutions;
  summary.child = {
    issue_number: childIssue.number,
    task_id: childId,
    issue_action: childCreated ? "CREATED" : "RESUMED",
    action: childAction,
    result_sha256: childTerminal.result_sha256,
  };
  return summary;
}
