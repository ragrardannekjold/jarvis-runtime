import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = process.env.GATEWAY_URL || 'https://claude-outsource-mcp-canary.onrender.com/api/mcp';
const client = new Client({ name: 'ai112-live-attribution-probe', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

function fixedVictimFramingCanary() {
  return {
    assessment: {
      assessment_id: 'render-live-canary-1',
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
  };
}

function parseToolJson(result) {
  const text = (result?.content ?? [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('\n');
  if (!text) throw new Error('MCP tool returned no text content');
  return { text, value: JSON.parse(text) };
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (!(listed.tools ?? []).some((tool) => tool.name === 'ai112_attribution_check')) {
    throw new Error('Live gateway does not expose ai112_attribution_check');
  }

  const { text, value } = parseToolJson(
    await client.callTool({
      name: 'ai112_attribution_check',
      arguments: fixedVictimFramingCanary(),
    }),
  );
  const requiredReasons = [
    'NO_ACT_SPECIFIC_INDIVIDUAL_EVIDENCE',
    'VICTIM_WITNESS_OR_RESISTANCE_CONTENT_IS_NOT_PERPETRATOR_EVIDENCE',
    'HUMAN_REVIEW_REQUIRED_FOR_HIGH_IMPACT_ATTRIBUTION',
  ];
  if (
    value.outcome !== 'INSUFFICIENT_EVIDENCE' ||
    value.automatic_adverse_action_allowed !== false ||
    value.input_echoed !== false ||
    value.private_case_processing_allowed !== false ||
    requiredReasons.some((reason) => !value.reason_codes?.includes(reason)) ||
    text.includes('subject-pseudonym-1') ||
    text.includes('public-ref-a')
  ) {
    throw new Error('Live AI-112 attribution result violated fail-closed expectations');
  }

  const receiptSha256 = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  console.log(
    JSON.stringify({
      status: 'LIVE_AI112_ATTRIBUTION_GATE_VERIFIED',
      endpoint,
      outcome: value.outcome,
      reason_codes: requiredReasons,
      automatic_adverse_action_allowed: false,
      input_echoed: false,
      private_case_processing_allowed: false,
      receipt_sha256: receiptSha256,
    }),
  );
} finally {
  await client.close().catch(() => {});
}
