import assert from "node:assert/strict";
import test from "node:test";

import { createGithubIssueClient } from "../integration/github_api_client.mjs";

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    },
  };
}

test("GitHub issue client performs trusted-author exact-task lookups", async () => {
  const calls = [];
  const client = createGithubIssueClient({
    repository: "owner/public-runtime",
    token: "native-short-lived-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/issues?")) {
        return jsonResponse([
          {
            number: 41,
            title: "[OUTSOURCE-TASK] task.one",
            body: "{}",
            user: { login: "repository-owner" },
          },
          {
            number: 99,
            title: "[OUTSOURCE-TASK] task.one",
            body: "{}",
            user: { login: "untrusted-user" },
          },
          {
            number: 12,
            title: "[OUTSOURCE-TASK] task.one",
            body: null,
            user: { login: "repository-owner" },
            pull_request: {},
          },
        ]);
      }
      return jsonResponse([]);
    },
  });

  const issues = await client.taskIssues("task.one", "repository-owner");
  assert.deepEqual(issues, [
    {
      number: 41,
      title: "[OUTSOURCE-TASK] task.one",
      body: "{}",
      user: { login: "repository-owner" },
    },
  ]);
  assert.match(
    calls[0].url,
    /^https:\/\/api\.github\.com\/repos\/owner\/public-runtime\/issues\?/,
  );
  assert.match(calls[0].url, /creator=repository-owner/);
  assert.match(calls[0].url, /state=all/);
  assert.equal(calls[0].options.redirect, "error");
});

test("GitHub issue client rejects untrusted lookup selectors", async () => {
  const client = createGithubIssueClient({
    repository: "owner/public-runtime",
    token: "native-short-lived-token",
  });
  await assert.rejects(client.taskIssues("bad task id", "owner"), /Invalid task_id/);
  await assert.rejects(
    client.taskIssues("task.one", "bad/login"),
    /Invalid trusted issue author/,
  );
});

test("GitHub issue client accepts the exact Actions bot and locks conversations", async () => {
  const calls = [];
  const client = createGithubIssueClient({
    repository: "owner/public-runtime",
    token: "native-short-lived-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "PUT") {
        return { ok: true, status: 204, async text() { return ""; } };
      }
      return jsonResponse([]);
    },
  });
  assert.deepEqual(
    await client.taskIssues("task.one.bubo", "github-actions[bot]"),
    [],
  );
  await client.lockIssue(41);
  assert.match(calls[0].url, /creator=github-actions%5Bbot%5D/);
  assert.match(calls[1].url, /\/issues\/41\/lock$/);
  assert.equal(calls[1].options.method, "PUT");
});

test("GitHub issue client rejects repository-path injection", () => {
  assert.throws(
    () =>
      createGithubIssueClient({
        repository: "owner/repo/extra",
        token: "native-short-lived-token",
      }),
    /Invalid GITHUB_REPOSITORY/,
  );
});
