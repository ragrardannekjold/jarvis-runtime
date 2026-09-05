import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { firecrawlCategories, observabilityProfile, validateTask } from './task_contract.mjs';

const TERMINAL_MARKER = '<!-- INVESTIGATION-RESEARCH-TERMINAL-V1 -->';
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://claude-outsource-mcp-canary.onrender.com/api/mcp';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function trimProviderText(value, max = 14000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n...[TRUNCATED ${text.length - max} chars]`;
}

function textContent(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function githubHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };
}

async function githubJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(token), ...(init.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function existingTerminal({ apiUrl, issueNumber, token }) {
  const comments = await githubJson(`${apiUrl}/issues/${issueNumber}/comments?per_page=100`, token);
  return comments.find((comment) => typeof comment?.body === 'string' && comment.body.includes(TERMINAL_MARKER)) || null;
}

async function lockIssue({ apiUrl, issueNumber, token }) {
  await githubJson(`${apiUrl}/issues/${issueNumber}/lock`, token, { method: 'PUT' });
}

async function postComment({ apiUrl, issueNumber, token, body }) {
  return githubJson(`${apiUrl}/issues/${issueNumber}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

function safeCommentJson(value) {
  return JSON.stringify(value, null, 2).replaceAll('```', '\\u0060\\u0060\\u0060');
}

const event = JSON.parse(await readFile(requiredEnv('GITHUB_EVENT_PATH'), 'utf8'));
const token = requiredEnv('GITHUB_TOKEN');
const repository = requiredEnv('GITHUB_REPOSITORY');
const issue = event?.issue;
const owner = event?.repository?.owner?.login;
if (!issue || event?.action !== 'opened') throw new Error('Expected an opened issue event');
if (issue?.user?.login !== owner) throw new Error('Only repository-owner tasks are accepted');
if (!String(issue.title || '').startsWith('[INVESTIGATION-TASK] ')) throw new Error('Unexpected issue title');

let parsed;
try {
  parsed = JSON.parse(issue.body || '');
} catch {
  throw new Error('Issue body must be strict JSON');
}
const task = validateTask(parsed);
if (!issue.title.endsWith(task.task_id)) throw new Error('Issue title must end with the exact task_id');

const apiUrl = `https://api.github.com/repos/${repository}`;
const prior = await existingTerminal({ apiUrl, issueNumber: issue.number, token });
if (prior) {
  console.log(JSON.stringify({ status: 'NOOP_ALREADY_TERMINAL', issue_number: issue.number, comment_id: prior.id }));
  process.exit(0);
}
await lockIssue({ apiUrl, issueNumber: issue.number, token });

const client = new Client({ name: 'jarvis-investigation-dispatch', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL));
let exaText = '';
let firecrawlText = '';
let connectorStatus = '';
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  for (const required of ['resource_connector_status', 'exa_web_search', 'firecrawl_search']) {
    if (!names.has(required)) throw new Error(`Gateway missing required tool ${required}`);
  }

  connectorStatus = trimProviderText(textContent(await client.callTool({
    name: 'resource_connector_status',
    arguments: {},
  })), 5000);

  exaText = trimProviderText(textContent(await client.callTool({
    name: 'exa_web_search',
    arguments: {
      query: task.question,
      num_results: task.max_results,
    },
  })));

  const categories = firecrawlCategories(task.search_profile);
  firecrawlText = trimProviderText(textContent(await client.callTool({
    name: 'firecrawl_search',
    arguments: {
      query: task.question,
      limit: task.max_results,
      ...(categories.length ? { categories } : {}),
      source_type: 'web',
    },
  })));
} finally {
  await client.close().catch(() => {});
}

const taskFingerprint = hash(JSON.stringify(task));
const providerReceipt = {
  exa_sha256: hash(exaText),
  firecrawl_sha256: hash(firecrawlText),
  connector_status_sha256: hash(connectorStatus),
};
const terminal = {
  schema: 'investigation.public_research_terminal.v1',
  task_id: task.task_id,
  case_id: task.case_id,
  task_fingerprint_sha256: taskFingerprint,
  run_state: 'CLOSED',
  outcome_state: 'TERMINAL_RESULT',
  evidence_maturity: 'LEAD_ONLY',
  material_delta: 'NO_VERIFIED_DELTA_AT_SCOUT_STAGE',
  model_output_is_evidence: false,
  model_consensus_is_corroboration: false,
  aggressor_or_state_controlled_source_policy: 'SOURCE_UNDER_ANALYSIS_REQUIRES_INDEPENDENT_VERIFICATION',
  canonical_admission: 'PENDING',
  observability: observabilityProfile(task),
  provider_receipt: providerReceipt,
  connector_status: connectorStatus,
  raw_lead_families: [
    {
      provider: 'exa',
      evidence_class: 'LEAD',
      source_genealogy: 'UNRESOLVED',
      exact_locator_normalization: 'REQUIRED_BEFORE_FACTUAL_CANDIDATE',
      payload: exaText,
    },
    {
      provider: 'firecrawl',
      evidence_class: 'LEAD',
      source_genealogy: 'UNRESOLVED',
      exact_locator_normalization: 'REQUIRED_BEFORE_FACTUAL_CANDIDATE',
      payload: firecrawlText,
    },
  ],
  contradictions: [],
  next_best_discriminator: 'L1_NORMALIZE_URLS_SOURCE_GENEALOGY_EXACT_LOCATORS_THEN_VERIFY_PRIMARY_SOURCES',
  next_route: 'L1',
  user_action: 'NONE',
};
terminal.result_sha256 = hash(JSON.stringify(terminal));

const body = `${TERMINAL_MARKER}\n## Investigation external scout terminal\n\n\`\`\`json\n${safeCommentJson(terminal)}\n\`\`\``;
const posted = await postComment({ apiUrl, issueNumber: issue.number, token, body });
if (!posted?.body?.includes(TERMINAL_MARKER)) throw new Error('Terminal comment readback mismatch');

console.log(JSON.stringify({
  status: 'TERMINAL_READBACK_OK',
  issue_number: issue.number,
  comment_id: posted.id,
  task_id: task.task_id,
  result_sha256: terminal.result_sha256,
}));
