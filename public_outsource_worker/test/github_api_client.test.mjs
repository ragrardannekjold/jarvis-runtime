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

test("GitHub issue client stays in one fixed repository and preserves issue numbers", async () => {
  const calls = [];
  const client = createGithubIssueClient({
    repository: "owner/public-runtime",
    token: "native-short-lived-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/issues?")) {
        return jsonResponse([
          { number: 41, title: "[OUTSOURCE-TASK] task.one", body: "{}" },
          { number: 12, title: "pull request", body: null, pull_request: {} },
        ]);
      }
      return jsonResponse([]);
    },
  });

  const issues = await client.issues();
  assert.deepEqual(issues, [
    { number: 41, title: "[OUTSOURCE-TASK] task.one", body: "{}" },
  ]);
  assert.match(
    calls[0].url,
    /^https:\/\/api\.github\.com\/repos\/owner\/public-runtime\/issues\?/,
  );
  assert.equal(calls[0].options.redirect, "error");
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
