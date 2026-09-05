import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = process.env.GATEWAY_URL || 'https://claude-outsource-mcp-canary.onrender.com/api/mcp';
const client = new Client({ name: 'jarvis-live-gateway-probe', version: '0.1.0' });
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
  for (const required of ['resource_connector_status', 'exa_web_search', 'firecrawl_search']) {
    if (!names.has(required)) throw new Error(`Missing live gateway tool: ${required}`);
  }

  const status = parseText(await client.callTool({ name: 'resource_connector_status', arguments: {} }));
  if (!status.includes('REMOTE_ENDPOINT_PROBED') || !status.includes('exa') || !status.includes('firecrawl')) {
    throw new Error('Live connector manifest is not the expected v1 state');
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

  console.log(JSON.stringify({
    status: 'LIVE_GATEWAY_EXTERNAL_RESOURCES_VERIFIED',
    endpoint,
    verified_tools: ['resource_connector_status', 'exa_web_search', 'firecrawl_search'],
  }));
} finally {
  await client.close().catch(() => {});
}
