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
    'ai112_attribution_check',
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

  const attribution = parseText(await client.callTool({
    name: 'ai112_attribution_check',
    arguments: {
      assessment: {
        assessment_id: 'render-canary-1',
        subject_ref: 'subject-pseudonym-1',
        attribution_level: 'INDIVIDUAL',
        requested_conclusion: 'INDIVIDUAL_CONDUCT_LINK',
        requested_action: 'RESEARCH_ONLY',
        evidence: [
          {
            evidence_id: 'e1',
            source_family_id: 'family-a',
            provenance_root_id: 'root-a',
            provenance_ref: 'public-ref-a',
            access_state: 'AVAILABLE',
            source_reliability: 'HIGH',
            information_credibility: 'HIGH',
            supports_claims: ['INDIVIDUAL_CONDUCT_LINK'],
            subject_roles: ['VICTIM'],
            act_specific: false,
            original_or_earliest_known: true,
            transformation_log_present: true,
          },
          {
            evidence_id: 'e2',
            source_family_id: 'family-b',
            provenance_root_id: 'root-b',
            provenance_ref: 'public-ref-b',
            access_state: 'AVAILABLE',
            source_reliability: 'HIGH',
            information_credibility: 'HIGH',
            supports_claims: ['INDIVIDUAL_CONDUCT_LINK'],
            subject_roles: ['WITNESS'],
            act_specific: false,
            original_or_earliest_known: true,
            transformation_log_present: true,
          },
        ],
        alternative_hypotheses: [
          'VICTIM_OR_WITNESS',
          'RESISTANCE_TO_RF_CRIME',
          'UNRELATED_OR_IDENTITY_COLLISION',
          'MANIPULATION_OR_FALSE_FLAG',
        ],
        exculpatory_search_completed: true,
        falsifiers: ['falsifier-1'],
        assumptions: ['assumption-1'],
        uncertainties: ['uncertainty-1'],
        identity_resolution_checked: true,
        peer_review_refs: ['reviewer-1'],
      },
    },
  }));
  if (
    !attribution.includes('"outcome": "INSUFFICIENT_EVIDENCE"') ||
    !attribution.includes('"automatic_adverse_action_allowed": false') ||
    !attribution.includes('"input_echoed": false') ||
    !attribution.includes('VICTIM_WITNESS_OR_RESISTANCE_CONTENT_IS_NOT_PERPETRATOR_EVIDENCE') ||
    attribution.includes('subject-pseudonym-1') ||
    attribution.includes('public-ref-a')
  ) {
    throw new Error('AI-112 live attribution gate did not fail closed with a non-echo receipt');
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
