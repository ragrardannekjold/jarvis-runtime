import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const providers = [
  { id: 'exa', endpoint: 'https://mcp.exa.ai/mcp' },
  { id: 'firecrawl', endpoint: 'https://mcp.firecrawl.dev/v2/mcp' },
];

for (const provider of providers) {
  const client = new Client({ name: 'jarvis-provider-probe', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(provider.endpoint));
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = (listed.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? null,
    }));
    console.log(JSON.stringify({
      provider: provider.id,
      endpoint: provider.endpoint,
      status: 'REMOTE_MCP_REACHABLE',
      tool_count: tools.length,
      tools,
    }));
  } finally {
    await client.close().catch(() => {});
  }
}
