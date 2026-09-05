import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { createPublicRuntime } from '../../../public_outsource_worker/src/runtime.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const publicRuntime = createPublicRuntime();
const CANARY_RECORD_ID = '267a034fb6674d629db7aaacddff36b8';
const CASE_ID = 'CLAUDE-MCP-CANARY';

const EXA_ENDPOINT = 'https://mcp.exa.ai/mcp';
const FIRECRAWL_ENDPOINT = 'https://mcp.firecrawl.dev/v2/mcp';

const EXTERNAL_RESOURCES = [
  {
    id: 'exa',
    mode: 'REMOTE_MCP_KEYLESS',
    endpoint: EXA_ENDPOINT,
    state: 'REMOTE_ENDPOINT_PROBED',
    exposed_tools: ['exa_web_search', 'exa_web_fetch'],
    upstream_tools: ['web_search_exa', 'web_fetch_exa'],
  },
  {
    id: 'firecrawl',
    mode: 'REMOTE_MCP_KEYLESS',
    endpoint: FIRECRAWL_ENDPOINT,
    state: 'REMOTE_ENDPOINT_PROBED',
    exposed_tools: [
      'firecrawl_search',
      'firecrawl_scrape',
      'research_paper_search',
      'research_pdf_read',
      'source_reputation_scout',
    ],
    upstream_tools: ['firecrawl_search', 'firecrawl_scrape'],
  },
  {
    id: 'alphaxiv',
    mode: 'REMOTE_MCP',
    endpoint: 'https://api.alphaxiv.org/mcp/v1',
    state: 'AUTH_REQUIRED_NONINTERACTIVE',
    auth: 'OAUTH_2_1_OR_API_KEY',
    fallback: ['research_paper_search', 'research_pdf_read'],
    fallback_equivalence: false,
  },
  {
    id: 'haveibeenpwned',
    mode: 'REST_API',
    endpoint: 'https://haveibeenpwned.com/api/v3',
    state: 'AUTH_REQUIRED_FOR_ACCOUNT_LOOKUP',
    auth: 'HIBP_API_KEY',
    note: 'Pwned Passwords is keyless but is not the requested account/email breach lookup surface. No substitute is promoted as equivalent.',
  },
  {
    id: 'malwarebytes',
    mode: 'HOST_APP_PLUGIN',
    state: 'PLUGIN_INSTALLATION_SURFACE_ONLY',
    auth: 'NO_ACCOUNT_REQUIRED_FOR_CHATGPT_PLUGIN',
    fallback: ['source_reputation_scout'],
    fallback_equivalence: false,
  },
  {
    id: 'norton',
    mode: 'HOST_APP_PLUGIN',
    state: 'PLUGIN_INSTALLATION_SURFACE_ONLY',
    fallback: ['source_reputation_scout'],
    fallback_equivalence: false,
  },
  {
    id: 'grain',
    mode: 'REMOTE_MCP',
    endpoint: 'https://api.grain.com/_/mcp',
    state: 'OWNER_OAUTH_REQUIRED',
    auth: 'OAUTH',
    note: 'Private meeting/transcript data is not substituted with public search.',
  },
];

function asToolResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function taskSuffix(runId) {
  return createHash('sha256')
    .update(runId || 'default')
    .digest('hex')
    .slice(0, 16);
}

async function callRemoteMcpTool(endpoint, toolName, args) {
  const client = new Client({ name: 'jarvis-outsource-gateway', version: '0.3.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  try {
    await client.connect(transport);
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

const handler = createMcpHandler((server) => {
  server.registerTool(
    'outsource_capabilities',
    {
      title: 'Outsource Capabilities',
      description:
        'Lists bounded public outsource and external research capabilities exposed by this Claude canary gateway. This is capability discovery, not canonical truth.',
      inputSchema: z.object({}),
    },
    async () =>
      asToolResult({
        schema: 'claude.outsource_capabilities.v3',
        mode: 'PUBLIC_CANARY_ONLY',
        capabilities: publicRuntime.registry.list(),
        external_resources: EXTERNAL_RESOURCES,
        canonical_write: false,
        direct_arbitrary_network_access: false,
        provider_mediated_public_web_access: true,
        private_data_access: false,
      }),
  );

  server.registerTool(
    'resource_connector_status',
    {
      title: 'Resource Connector Status',
      description:
        'Returns configured external resource states. States distinguish verified keyless remote endpoints, bounded fallbacks, and providers that still require OAuth, API keys, or host-app installation.',
      inputSchema: z.object({}),
    },
    async () =>
      asToolResult({
        schema: 'claude.resource_connector_status.v2',
        resources: EXTERNAL_RESOURCES,
        canonical_admission: 'NOT_APPLICABLE',
      }),
  );

  server.registerTool(
    'outsource_health',
    {
      title: 'Outsource Health',
      description:
        'Returns the gateway request-path state and capability registry. It does not claim background liveness beyond this request.',
      inputSchema: z.object({}),
    },
    async () =>
      asToolResult({
        schema: 'claude.outsource_health.v3',
        status: 'REQUEST_PATH_ALIVE',
        mode: 'PUBLIC_CANARY_ONLY',
        capabilities: publicRuntime.registry.list(),
        external_resources: EXTERNAL_RESOURCES.map(({ id, state, exposed_tools, fallback }) => ({
          id,
          state,
          exposed_tools,
          fallback,
        })),
        durable_scheduler_verified: false,
        canonical_write: false,
      }),
  );

  server.registerTool(
    'exa_web_search',
    {
      title: 'Exa Web Search',
      description:
        'Bounded keyless Exa broad-scout web search. Use for current web, technical documentation, code-oriented discovery, companies, people, and research leads. Results are leads/observations until independently verified.',
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        num_results: z.number().int().min(1).max(10).optional(),
      }),
    },
    async ({ query, num_results }) => {
      const upstream = await callRemoteMcpTool(EXA_ENDPOINT, 'web_search_exa', {
        query,
        ...(num_results ? { numResults: num_results } : {}),
      });
      return asToolResult({
        schema: 'claude.external_resource_result.v1',
        provider: 'exa',
        upstream_tool: 'web_search_exa',
        evidence_class: 'LEAD_OR_OBSERVATION',
        canonical_admission: 'PENDING',
        upstream,
      });
    },
  );

  server.registerTool(
    'exa_web_fetch',
    {
      title: 'Exa Web Fetch',
      description:
        'Reads clean text from a bounded set of public URLs through Exa. Use after discovery when page-level content is needed for extraction or verification.',
      inputSchema: z.object({
        urls: z.array(z.string().url()).min(1).max(5),
        max_characters: z.number().int().min(1).max(10000).optional(),
      }),
    },
    async ({ urls, max_characters }) => {
      const upstream = await callRemoteMcpTool(EXA_ENDPOINT, 'web_fetch_exa', {
        urls,
        ...(max_characters ? { maxCharacters: max_characters } : {}),
      });
      return asToolResult({
        schema: 'claude.external_resource_result.v1',
        provider: 'exa',
        upstream_tool: 'web_fetch_exa',
        evidence_class: 'OBSERVATION',
        canonical_admission: 'PENDING',
        upstream,
      });
    },
  );

  server.registerTool(
    'firecrawl_search',
    {
      title: 'Firecrawl Search',
      description:
        'Bounded keyless Firecrawl search for web, research, PDF, GitHub, and developer sources. Use categories research/developer/github/pdf to route scientific or code discovery.',
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(20).optional(),
        categories: z.array(z.enum(['github', 'research', 'pdf', 'developer'])).max(4).optional(),
        source_type: z.enum(['web', 'news']).optional(),
      }),
    },
    async ({ query, limit, categories, source_type }) => {
      const upstream = await callRemoteMcpTool(FIRECRAWL_ENDPOINT, 'firecrawl_search', {
        query,
        ...(limit ? { limit } : {}),
        ...(categories?.length ? { categories } : {}),
        sources: [{ type: source_type || 'web' }],
        highlights: true,
      });
      return asToolResult({
        schema: 'claude.external_resource_result.v1',
        provider: 'firecrawl',
        upstream_tool: 'firecrawl_search',
        evidence_class: 'LEAD_OR_OBSERVATION',
        canonical_admission: 'PENDING',
        upstream,
      });
    },
  );

  server.registerTool(
    'firecrawl_scrape',
    {
      title: 'Firecrawl Scrape',
      description:
        'Fetches one public URL through Firecrawl as main-content markdown with PII redaction requested. No browser actions, form filling, arbitrary code execution, or direct gateway fetch is exposed.',
      inputSchema: z.object({
        url: z.string().url(),
        max_age_ms: z.number().int().min(0).max(86400000).optional(),
      }),
    },
    async ({ url, max_age_ms }) => {
      const upstream = await callRemoteMcpTool(FIRECRAWL_ENDPOINT, 'firecrawl_scrape', {
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        redactPII: true,
        ...(max_age_ms !== undefined ? { maxAge: max_age_ms } : {}),
      });
      return asToolResult({
        schema: 'claude.external_resource_result.v1',
        provider: 'firecrawl',
        upstream_tool: 'firecrawl_scrape',
        evidence_class: 'OBSERVATION',
        canonical_admission: 'PENDING',
        upstream,
      });
    },
  );

  server.registerTool(
    'research_paper_search',
    {
      title: 'Research Paper Search',
      description:
        'Scientific/preprint discovery fallback while direct alphaXiv remains authorization-bound. Searches research and PDF sources through verified Firecrawl. It is not represented as alphaXiv-equivalent.',
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    },
    async ({ query, limit }) => {
      const upstream = await callRemoteMcpTool(FIRECRAWL_ENDPOINT, 'firecrawl_search', {
        query,
        limit: limit || 10,
        categories: ['research', 'pdf'],
        sources: [{ type: 'web' }],
        highlights: true,
      });
      return asToolResult({
        schema: 'claude.research_fallback_result.v1',
        provider: 'firecrawl',
        fallback_for: 'alphaxiv',
        fallback_equivalence: false,
        upstream_tool: 'firecrawl_search',
        evidence_class: 'LEAD_OR_OBSERVATION',
        canonical_admission: 'PENDING',
        upstream,
      });
    },
  );

  server.registerTool(
    'research_pdf_read',
    {
      title: 'Research PDF Read',
      description:
        'Reads a known public research/PDF URL through verified Firecrawl with a bounded page limit. This is a scientific full-text fallback, not a direct alphaXiv connection.',
      inputSchema: z.object({
        url: z.string().url(),
        max_pages: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ url, max_pages }) => {
      const upstream = await callRemoteMcpTool(FIRECRAWL_ENDPOINT, 'firecrawl_scrape', {
        url,
        formats: ['markdown'],
        parsers: ['pdf'],
        pdfOptions: { maxPages: max_pages || 50 },
        onlyMainContent: true,
        redactPII: true,
      });
      return asToolResult({
        schema: 'claude.research_fallback_result.v1',
        provider: 'firecrawl',
        fallback_for: 'alphaxiv',
        fallback_equivalence: false,
        upstream_tool: 'firecrawl_scrape',
        evidence_class: 'OBSERVATION',
        canonical_admission: 'PENDING',
        upstream,
      });
    },
  );

  server.registerTool(
    'source_reputation_scout',
    {
      title: 'Source Reputation Scout',
      description:
        'Lead-only reputation scout against public Norton/Malwarebytes-owned web surfaces while their native host connectors are not server-side connected. It must not be treated as a Norton or Malwarebytes verdict.',
      inputSchema: z.object({
        url: z.string().url(),
        context: z.string().max(500).optional(),
      }),
    },
    async ({ url, context }) => {
      const suffix = context ? ` ${context}` : '';
      const [norton, malwarebytes] = await Promise.all([
        callRemoteMcpTool(FIRECRAWL_ENDPOINT, 'firecrawl_search', {
          query: `${url} reputation safety threat${suffix}`,
          limit: 5,
          includeDomains: ['safeweb.norton.com', 'norton.com'],
          sources: [{ type: 'web' }],
          highlights: true,
        }),
        callRemoteMcpTool(FIRECRAWL_ENDPOINT, 'firecrawl_search', {
          query: `${url} reputation safety scam malware${suffix}`,
          limit: 5,
          includeDomains: ['malwarebytes.com'],
          sources: [{ type: 'web' }],
          highlights: true,
        }),
      ]);

      return asToolResult({
        schema: 'claude.source_reputation_scout.v1',
        providers_scouted: ['norton_public_web', 'malwarebytes_public_web'],
        native_vendor_connector_connected: false,
        evidence_class: 'LEAD_ONLY',
        vendor_verdict: 'NOT_ESTABLISHED',
        canonical_admission: 'PENDING',
        norton,
        malwarebytes,
      });
    },
  );

  server.registerTool(
    'outsource_dispatch_canary',
    {
      title: 'Run Outsource Canary',
      description:
        'Executes the real public Cuckoo -> BUBO bounded worker chain against one fixed official Prozorro fixture. No private data, tactical data, secret access, or canonical write is possible.',
      inputSchema: z.object({
        run_id: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,48}$/)
          .optional()
          .describe('Optional idempotency label for the canary call.'),
      }),
    },
    async ({ run_id }) => {
      const suffix = taskSuffix(run_id);
      const cuckoo = await publicRuntime.dispatcher.dispatch({
        task_id: `claude.mcp.cuckoo.${suffix}`,
        case_id: CASE_ID,
        worker: 'cuckoo',
        capability: 'prozorro_snapshot_v1',
        sensitivity: 'PUBLIC',
        payload: {
          record_id: CANARY_RECORD_ID,
        },
      });

      const bubo = await publicRuntime.dispatcher.dispatch({
        task_id: `claude.mcp.bubo.${suffix}`,
        case_id: CASE_ID,
        worker: 'bubo',
        capability: 'evidence_packet_v1',
        sensitivity: 'PUBLIC',
        payload: {
          cuckoo_result: cuckoo.result,
        },
      });

      return asToolResult({
        schema: 'claude.outsource_canary_receipt.v1',
        mode: 'PUBLIC_CANARY_ONLY',
        run_id: run_id || 'default',
        worker_chain: ['cuckoo:prozorro_snapshot_v1', 'bubo:evidence_packet_v1'],
        candidate_only: true,
        canonical_admission: 'PENDING_VERIFIER',
        cuckoo,
        bubo,
      });
    },
  );
});

export { handler as GET, handler as POST };
