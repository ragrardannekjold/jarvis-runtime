const GITHUB_API = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
    async issues() {
      const items = await allPages(`${repoRoot}/issues?state=all&`);
      return items.filter((item) => !item?.pull_request);
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
