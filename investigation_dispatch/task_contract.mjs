const EXACT_KEYS = new Set([
  'schema',
  'task_id',
  'case_id',
  'question',
  'scope',
  'search_profile',
  'max_results',
]);

const ALLOWED_SCOPES = new Set([
  'PUBLIC_HISTORICAL',
  'PUBLIC_DOCUMENTARY',
  'PUBLIC_TECHNICAL',
  'PUBLIC_CORPORATE',
]);

const ALLOWED_PROFILES = new Set([
  'broad',
  'research',
  'developer',
  'documentary',
]);

const TACTICAL_PATTERNS = [
  /(?:^|\W)(?:live|current|real[- ]?time)\s+(?:position|location|coordinates?)(?:\W|$)/iu,
  /(?:^|\W)(?:точн\w*\s+)?(?:актуальн\w*|поточн\w*)\s+(?:позиці\w*|координат\w*|місцезнаходжен\w*)(?:\W|$)/iu,
  /(?:^|\W)(?:частот\w*|frequency|waveform|емітер\w*|emitter|ретранслятор\w*|relay)\s+(?:позиці\w*|координат\w*|location|position)(?:\W|$)/iu,
  /(?:^|\W)(?:route\s+bypass|surveillance[- ]?evasion|strike\s+target|targeting\s+coordinates?)(?:\W|$)/iu,
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function validateTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_TASK', 'Task body must be one JSON object');
  }
  const keys = Object.keys(input);
  for (const key of keys) {
    if (!EXACT_KEYS.has(key)) fail('EXTRA_TASK_KEY', `Unexpected task key: ${key}`);
  }
  for (const required of ['schema', 'task_id', 'case_id', 'question', 'scope', 'search_profile']) {
    if (!(required in input)) fail('MISSING_TASK_KEY', `Missing task key: ${required}`);
  }
  if (input.schema !== 'investigation.public_research_task.v1') {
    fail('INVALID_SCHEMA', 'Unsupported task schema');
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(input.task_id)) {
    fail('INVALID_TASK_ID', 'task_id must be 1-80 safe characters');
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(input.case_id)) {
    fail('INVALID_CASE_ID', 'case_id must be 1-80 safe characters');
  }
  if (typeof input.question !== 'string' || input.question.trim().length < 3 || input.question.length > 2000) {
    fail('INVALID_QUESTION', 'question must be 3-2000 characters');
  }
  if (!ALLOWED_SCOPES.has(input.scope)) fail('INVALID_SCOPE', 'scope is not allowed');
  if (!ALLOWED_PROFILES.has(input.search_profile)) fail('INVALID_PROFILE', 'search_profile is not allowed');
  const maxResults = input.max_results ?? 6;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    fail('INVALID_MAX_RESULTS', 'max_results must be an integer from 1 to 10');
  }
  if (TACTICAL_PATTERNS.some((pattern) => pattern.test(input.question))) {
    fail('TACTICAL_QUERY_REJECTED', 'Current tactical positioning/targeting query is outside this public research bridge');
  }
  return Object.freeze({ ...input, question: input.question.trim(), max_results: maxResults });
}

export function firecrawlCategories(profile) {
  if (profile === 'research') return ['research', 'pdf'];
  if (profile === 'developer') return ['developer', 'github'];
  if (profile === 'documentary') return ['pdf'];
  return [];
}

export function observabilityProfile(task) {
  return {
    providers_requested: ['exa', 'firecrawl'],
    search_profile: task.search_profile,
    max_results_per_provider: task.max_results,
    scope: task.scope,
    source_genealogy_resolution: 'UNRESOLVED_AT_SCOUT_STAGE',
    negative_result_semantics: 'UNKNOWN_UNLESS_PROVIDER_VISIBILITY_IS_ESTABLISHED',
  };
}
