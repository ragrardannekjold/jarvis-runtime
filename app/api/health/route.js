import { createPublicRuntime } from '../../../public_outsource_worker/src/runtime.mjs';

export const runtime = 'nodejs';

const publicRuntime = createPublicRuntime();

const externalResources = [
  { id: 'exa', state: 'REMOTE_ENDPOINT_PROBED', exposed_tools: ['exa_web_search', 'exa_web_fetch'] },
  { id: 'firecrawl', state: 'REMOTE_ENDPOINT_PROBED', exposed_tools: ['firecrawl_search', 'firecrawl_scrape'] },
  { id: 'alphaxiv', state: 'AUTH_REQUIRED_NONINTERACTIVE' },
  { id: 'haveibeenpwned', state: 'AUTH_REQUIRED_FOR_ACCOUNT_LOOKUP' },
  { id: 'malwarebytes', state: 'PLUGIN_INSTALLATION_SURFACE_ONLY' },
  { id: 'norton', state: 'PLUGIN_INSTALLATION_SURFACE_ONLY' },
  { id: 'grain', state: 'OWNER_OAUTH_REQUIRED' },
];

export async function GET() {
  return Response.json({
    schema: 'claude.outsource_gateway_health.v2',
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
