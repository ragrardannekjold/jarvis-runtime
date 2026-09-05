import { createPublicRuntime } from '../../../public_outsource_worker/src/runtime.mjs';

export const runtime = 'nodejs';

const publicRuntime = createPublicRuntime();

const externalResources = [
  { id: 'exa', state: 'REMOTE_ENDPOINT_PROBED', exposed_tools: ['exa_web_search', 'exa_web_fetch'] },
  {
    id: 'firecrawl',
    state: 'REMOTE_ENDPOINT_PROBED',
    exposed_tools: [
      'firecrawl_search',
      'firecrawl_scrape',
      'research_paper_search',
      'research_pdf_read',
      'source_reputation_scout',
    ],
  },
  {
    id: 'alphaxiv',
    state: 'AUTH_REQUIRED_NONINTERACTIVE',
    fallback: ['research_paper_search', 'research_pdf_read'],
    fallback_equivalence: false,
  },
  { id: 'haveibeenpwned', state: 'AUTH_REQUIRED_FOR_ACCOUNT_LOOKUP', fallback: [] },
  {
    id: 'malwarebytes',
    state: 'PLUGIN_INSTALLATION_SURFACE_ONLY',
    fallback: ['source_reputation_scout'],
    fallback_equivalence: false,
  },
  {
    id: 'norton',
    state: 'PLUGIN_INSTALLATION_SURFACE_ONLY',
    fallback: ['source_reputation_scout'],
    fallback_equivalence: false,
  },
  { id: 'grain', state: 'OWNER_OAUTH_REQUIRED', fallback: [] },
];

export async function GET() {
  return Response.json({
    schema: 'claude.outsource_gateway_health.v3',
    status: 'REQUEST_PATH_ALIVE',
    mode: 'PUBLIC_CANARY_ONLY',
    capabilities: publicRuntime.registry.list(),
    external_resources: externalResources,
    canonical_write: false,
    direct_arbitrary_network_access: false,
    provider_mediated_public_web_access: true,
    private_data_access: false,
    durable_scheduler_verified: false,
  });
}
