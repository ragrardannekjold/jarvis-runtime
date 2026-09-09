import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePublicAttributionEnvelope } from '../lib/ai112-attribution-gate.mjs';

function evidence(id, root, roles = ['VICTIM']) {
  return {
    evidence_id: id,
    source_family_id: `family-${id}`,
    provenance_root_id: root,
    provenance_ref: `public-ref-${id}`,
    access_state: 'AVAILABLE',
    source_reliability: 'HIGH',
    information_credibility: 'HIGH',
    supports_claims: ['INDIVIDUAL_CONDUCT_LINK'],
    subject_roles: roles,
    act_specific: false,
    original_or_earliest_known: true,
    transformation_log_present: true,
  };
}

function victimEnvelope() {
  return {
    assessment: {
      assessment_id: 'assessment-canary-1',
      subject_ref: 'subject-pseudonym-1',
      attribution_level: 'INDIVIDUAL',
      requested_conclusion: 'INDIVIDUAL_CONDUCT_LINK',
      requested_action: 'RESEARCH_ONLY',
      evidence: [evidence('e1', 'root-a'), evidence('e2', 'root-b', ['WITNESS'])],
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

test('victim and witness material fails closed without adverse action or input echo', () => {
  const result = evaluatePublicAttributionEnvelope(victimEnvelope());
  assert.equal(result.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.automatic_adverse_action_allowed, false);
  assert.equal(result.input_echoed, false);
  assert.equal(result.private_case_processing_allowed, false);
  assert.ok(result.reason_codes.includes('NO_ACT_SPECIFIC_INDIVIDUAL_EVIDENCE'));
  assert.ok(result.reason_codes.includes('VICTIM_WITNESS_OR_RESISTANCE_CONTENT_IS_NOT_PERPETRATOR_EVIDENCE'));
  assert.equal(JSON.stringify(result).includes('subject-pseudonym-1'), false);
  assert.equal(JSON.stringify(result).includes('public-ref-e1'), false);
});

test('enemy label is never an automated conclusion', () => {
  const input = victimEnvelope();
  input.assessment.attribution_level = 'CONTEXT';
  input.assessment.requested_conclusion = 'ENEMY';
  input.assessment.evidence[0].supports_claims = ['ENEMY'];
  input.assessment.evidence = [input.assessment.evidence[0]];
  const result = evaluatePublicAttributionEnvelope(input);
  assert.equal(result.outcome, 'PROHIBITED_AUTOMATED_CONCLUSION');
  assert.ok(result.reason_codes.includes('LABEL_REQUIRES_COMPETENT_HUMAN_LEGAL_AUTHORITY'));
  assert.equal(result.automatic_adverse_action_allowed, false);
});

test('mirrors with one provenance root count once', () => {
  const input = victimEnvelope();
  input.assessment.evidence[1].provenance_root_id = 'root-a';
  const result = evaluatePublicAttributionEnvelope(input);
  assert.equal(result.independent_provenance_roots, 1);
  assert.ok(result.reason_codes.includes('TWO_INDEPENDENT_PROVENANCE_ROOTS_MINIMUM'));
});

test('raw content and extra fields are rejected before evaluation', () => {
  const input = victimEnvelope();
  input.assessment.evidence[0].raw_content = 'must never be admitted';
  assert.throws(
    () => evaluatePublicAttributionEnvelope(input),
    /unsupported fields: raw_content/,
  );
});

test('references are bounded pseudonyms, not URLs or prose', () => {
  const input = victimEnvelope();
  input.assessment.subject_ref = 'https://example.com/real-person';
  assert.throws(
    () => evaluatePublicAttributionEnvelope(input),
    /bounded pseudonymous reference/,
  );
});

test('a simple observed event may pass as analytic evidence only', () => {
  const input = victimEnvelope();
  input.assessment.attribution_level = 'OBSERVED_EVENT';
  input.assessment.requested_conclusion = 'OBSERVED_CONDUCT';
  input.assessment.evidence = [{
    ...evidence('event-1', 'root-event', ['OTHER']),
    supports_claims: ['OBSERVED_CONDUCT'],
    act_specific: true,
  }];
  const result = evaluatePublicAttributionEnvelope(input);
  assert.equal(result.outcome, 'SUPPORTED_ANALYTIC_ASSESSMENT');
  assert.equal(result.automatic_adverse_action_allowed, false);
  assert.equal(result.model_output_counts_as_evidence, false);
});
