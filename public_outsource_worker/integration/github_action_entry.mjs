import { readFile } from "node:fs/promises";

import {
  coordinateIssueTask,
  createPublicRuntime,
  parseOwnerTaskIssue,
} from "../src/index.mjs";

const GITHUB_API = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function createGithubClient({ repository, token, fetchImpl = globalThis.fetch }) {
  if (!REPOSITORY.test(repository)) throw new Error("Invalid GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  const repoRoot = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function request(path, { method = "GET", body } = {}) {
    if (!path.startsWith(`${repoRoot}/`)) throw new Error("GitHub path escaped repository scope");
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      method,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "public-outsource-worker-v1",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`GitHub API ${method} failed with ${response.status}`);
    return raw ? JSON.parse(raw) : null;
  }

  async function allPages(pathWithoutPage) {
    const output = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = pathWithoutPage.includes("?") ? "&" : "?";
      const pageItems = await request(`${pathWithoutPage}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(pageItems)) throw new Error("GitHub list response is not an array");
      output.push(...pageItems);
      if (pageItems.length < 100) return output;
    }
    throw new Error("GitHub pagination safety limit reached");
  }

  return {
    comments(issueNumber) {
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        throw new Error("Invalid issue number");
      }
      return allPages(`${repoRoot}/issues/${issueNumber}/comments?`);
    },
    issues() {
      return allPages(`${repoRoot}/issues?state=all&`);
    },
    comment(issueNumber, body) {
      return request(`${repoRoot}/issues/${issueNumber}/comments`, {
        method: "POST",
        body: { body },
      });
    },
    createIssue(issue) {
      return request(`${repoRoot}/issues`, { method: "POST", body: issue });
    },
  };
}

async function main() {
  const eventPath = requiredEnv("GITHUB_EVENT_PATH");
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("GITHUB_TOKEN");
  const botLogin = process.env.OUTSOURCE_BOT_LOGIN ?? "github-actions[bot]";
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const descriptor = parseOwnerTaskIssue(event, { generatedBotLogin: botLogin });
  const client = createGithubClient({ repository, token });

  const [existingComments, existingIssues] = await Promise.all([
    client.comments(event.issue.number),
    client.issues(),
  ]);
  const priorComments = descriptor.depends_on
    ? await client.comments(descriptor.depends_on.issue_number)
    : [];
  const { dispatcher } = createPublicRuntime();
  const decision = await coordinateIssueTask({
    event,
    dispatcher,
    botLogin,
    existingComments,
    priorComments,
    existingIssues: existingIssues
      .filter((issue) => !issue.pull_request)
      .map(({ title, body }) => ({ title, body })),
  });

  if (decision.comment_body) {
    await client.comment(event.issue.number, decision.comment_body);
  }
  if (decision.next_issue) {
    await client.createIssue(decision.next_issue);
  }
  console.log(
    JSON.stringify({
      action: decision.action,
      task_id: decision.terminal.task_id,
      result_sha256: decision.terminal.result_sha256,
      next_issue_planned: Boolean(decision.next_issue),
    }),
  );
}

await main();
