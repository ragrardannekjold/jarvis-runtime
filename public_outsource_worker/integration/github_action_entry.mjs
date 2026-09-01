import { readFile } from "node:fs/promises";

import { runBoundedIssueChain } from "../src/github_issue_run.mjs";
import { createPublicRuntime } from "../src/runtime.mjs";
import { createGithubIssueClient } from "./github_api_client.mjs";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const event = JSON.parse(
  await readFile(requiredEnv("GITHUB_EVENT_PATH"), "utf8"),
);
const github = createGithubIssueClient({
  repository: requiredEnv("GITHUB_REPOSITORY"),
  token: requiredEnv("GITHUB_TOKEN"),
});
const { dispatcher } = createPublicRuntime();
const summary = await runBoundedIssueChain({
  event,
  dispatcher,
  botLogin: process.env.OUTSOURCE_BOT_LOGIN ?? "github-actions[bot]",
  github,
});

console.log(JSON.stringify(summary));
