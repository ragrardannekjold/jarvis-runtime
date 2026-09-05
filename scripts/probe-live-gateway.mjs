import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = process.env.GATEWAY_URL || 'https://claude-outsource-mcp-canary.onrender.com/api/mcp';
const client = new Client({ name: 'jarvis-live-gateway-probe', version: '0.2.0' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

function parseText(result) {
  const text = (result?.content ?? []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
  if (!text) throw new Error('MCP tool returned no text content');
  return text;
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  const requiredTools = [
    'resource_connector_status',
    'exa_web_search',
    'firecrawl_search',
    'research_paper_search',
    'source_reputation_scout',
  ];
  for (const required of requiredTools) {
    if (!names.has(required)) throw new Error(`Missing live gateway tool: ${required}`);
  }

  const status = parseText(await client.callTool({ name: 'resource_connector_status', arguments: {} }));
  if (
    !status.includes('REMOTE_ENDPOINT_PROBED') ||
    !status.includes('exa') ||
    !status.includes('firecrawl') ||
    !status.includes('fallback_equivalence')
  ) {
    throw new Error('Live connector manifest is not the expected v2 state');
  }

  const exa = parseText(await client.callTool({
    name: 'exa_web_search',
    arguments: { query: 'Model Context Protocol official specification', num_results: 2 },
  }));
  if (!exa.includes('"provider": "exa"') || !exa.includes('"canonical_admission": "PENDING"')) {
    throw new Error('Exa live proxy did not return the bounded gateway envelope');
  }

  const firecrawl = parseText(await client.callTool({
    name: 'firecrawl_search',
    arguments: { query: 'Model Context Protocol official specification', limit: 2, categories: ['developer'] },
  }));
  if (!firecrawl.includes('"provider": "firecrawl"') || !firecrawl.includes('"canonical_admission": "PENDING"')) {
    throw new Error('Firecrawl live proxy did not return the bounded gateway envelope');
  }

  const research = parseText(await client.callTool({
    name: 'research_paper_search',
    arguments: { query: 'Model Context Protocol arXiv preprint', limit: 2 },
  }));
  if (
    !research.includes('"fallback_for": "alphaxiv"') ||
    !research.includes('"fallback_equivalence": false') ||
    !research.includes('"canonical_admission": "PENDING"')
  ) {
    throw new Error('Scientific fallback did not return the bounded non-equivalence envelope');
  }

  const reputation = parseText(await client.callTool({
    name: 'source_reputation_scout',
    arguments: { url: 'https://example.com' },
  }));
  if (
    !reputation.includes('"native_vendor_connector_connected": false') ||
    !reputation.includes('"vendor_verdict": "NOT_ESTABLISHED"') ||
    !reputation.includes('"evidence_class": "LEAD_ONLY"')
  ) {
    throw new Error('Reputation scout did not preserve vendor-verdict boundary');
  }

  console.log(JSON.stringify({
    status: 'LIVE_GATEWAY_EXTERNAL_RESOURCES_AND_FALLBACKS_VERIFIED',
    endpoint,
    verified_tools: requiredTools,
  }));
} finally {
  await client.close().catch(() => {});
}
