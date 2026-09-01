const GITHUB_API = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TRUSTED_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ACTIONS_BOT_LOGIN = "github-actions[bot]";
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_TITLE_PREFIX = "[OUTSOURCE-TASK] ";

export function createGithubIssueClient({
  repository,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!REPOSITORY.test(repository)) throw new Error("Invalid GITHUB_REPOSITORY");
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Missing native GitHub token");
  }
  if (typeof fetchImpl !== "function") throw new Error("Missing fetch implementation");
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
    async taskIssues(taskId, trustedAuthorLogin) {
      if (typeof taskId !== "string" || !SAFE_TASK_ID.test(taskId)) {
        throw new Error("Invalid task_id lookup");
      }
      if (
        typeof trustedAuthorLogin !== "string" ||
        trustedAuthorLogin !== ACTIONS_BOT_LOGIN &&
        !TRUSTED_LOGIN.test(trustedAuthorLogin)
      ) {
        throw new Error("Invalid trusted issue author");
      }
      const items = await allPages(
        `${repoRoot}/issues?state=all&creator=${encodeURIComponent(trustedAuthorLogin)}&sort=created&direction=desc&`,
      );
      const title = `${TASK_TITLE_PREFIX}${taskId}`;
      return items.filter(
        (item) =>
          !item?.pull_request &&
          item?.title === title &&
          item?.user?.login === trustedAuthorLogin,
      );
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
    lockIssue(issueNumber) {
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        throw new Error("Invalid issue number");
      }
      return request(`${repoRoot}/issues/${issueNumber}/lock`, {
        method: "PUT",
      });
    },
  };
}
