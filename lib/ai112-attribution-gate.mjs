const PROTOCOL_ID = 'AI112_ATTRIBUTION_INTEGRITY_PROTOCOL_V1';

const PROHIBITED_CONCLUSIONS = new Set([
  'ENEMY',
  'TRAITOR',
  'CRIMINAL',
  'WAR_CRIMINAL',
  'RF_AGENT',
  'SPY',
  'COMBATANT',
  'LAWFUL_TARGET',
  'DIRECT_PARTICIPANT_IN_HOSTILITIES',
]);

const ALLOWED_CONCLUSIONS = new Set([
  'RF_STATE_AGGRESSION_CONTEXT',
  'OBSERVED_CONDUCT',
  'RF_STATE_OR_PROXY_LINK',
  'ORGANIZATION_CONDUCT_LINK',
  'INDIVIDUAL_CONDUCT_LINK',
  'OFFICIAL_SANCTIONS_DESIGNATION',
]);

const LEVEL_CONCLUSIONS = new Map([
  ['CONTEXT', 'RF_STATE_AGGRESSION_CONTEXT'],
  ['OBSERVED_EVENT', 'OBSERVED_CONDUCT'],
  ['ACTOR_CLASS', 'RF_STATE_OR_PROXY_LINK'],
  ['ORGANIZATION', 'ORGANIZATION_CONDUCT_LINK'],
  ['INDIVIDUAL', 'INDIVIDUAL_CONDUCT_LINK'],
  ['FORMAL_STATUS', 'OFFICIAL_SANCTIONS_DESIGNATION'],
]);

const VALID_ACTIONS = new Set([
  'RESEARCH_ONLY',
  'PUBLISH_PERSONAL_ATTRIBUTION',
  'COMPLIANCE_HOLD',
  'COMPLIANCE_BLOCK',
  'TARGETING',
]);

const PROTECTIVE_ROLES = new Set([
  'VICTIM',
  'WITNESS',
  'JOURNALIST',
  'HUMAN_RIGHTS_DEFENDER',
  'RESISTANCE_TO_RF_CRIME',
]);

const REQUIRED_INDIVIDUAL_ALTERNATIVES = new Set([
  'VICTIM_OR_WITNESS',
  'RESISTANCE_TO_RF_CRIME',
  'UNRELATED_OR_IDENTITY_COLLISION',
  'MANIPULATION_OR_FALSE_FLAG',
]);

const STABLE_REF = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_LIST_ITEMS = 20;

const ASSESSMENT_REQUIRED = new Set([
  'assessment_id',
  'subject_ref',
  'attribution_level',
  'requested_conclusion',
  'evidence',
]);

const ASSESSMENT_OPTIONAL = new Set([
  'requested_action',
  'alternative_hypotheses',
  'exculpatory_search_completed',
  'exculpatory_evidence_refs',
  'contrary_evidence_refs',
  'falsifiers',
  'assumptions',
  'uncertainties',
  'critical_gaps',
  'uses_missing_data_as_negative_evidence',
  'identity_resolution_checked',
  'peer_review_refs',
  'human_legal_review_ref',
]);

const EVIDENCE_REQUIRED = new Set([
  'evidence_id',
  'source_family_id',
  'provenance_root_id',
  'provenance_ref',
  'access_state',
  'source_reliability',
  'information_credibility',
  'supports_claims',
  'transformation_log_present',
]);

const EVIDENCE_OPTIONAL = new Set([
  'subject_roles',
  'act_specific',
  'original_or_earliest_known',
]);

function normalized(value) {
  return value.trim().toUpperCase().replaceAll(' ', '_');
}

function exactObject(value, required, optional, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value);
  const missing = [...required].filter((key) => !Object.hasOwn(value, key));
  const extra = keys.filter((key) => !required.has(key) && !optional.has(key));
  if (missing.length) throw new TypeError(`${name} missing required fields: ${missing.sort().join(',')}`);
  if (extra.length) throw new TypeError(`${name} contains unsupported fields: ${extra.sort().join(',')}`);
  return value;
}

function stableRef(value, name) {
  if (typeof value !== 'string' || !STABLE_REF.test(value)) {
    throw new TypeError(`${name} must be a bounded pseudonymous reference`);
  }
  return value;
}

function enumValue(value, allowed, name, fallback) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'string') throw new TypeError(`${name} must be a string`);
  const result = normalized(candidate);
  if (!allowed.has(result)) throw new TypeError(`${name} is unsupported`);
  return result;
}

function booleanValue(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}

function stableRefList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new TypeError(`${name} must be a bounded list`);
  }
  return value.map((item, index) => stableRef(item, `${name}[${index}]`));
}

function enumList(value, allowed, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new TypeError(`${name} must be a bounded list`);
  }
  return value.map((item) => enumValue(item, allowed, name));
}

const RELIABILITY = new Set(['LOW', 'MODERATE', 'HIGH', 'UNKNOWN']);
const ACCESS_STATES = new Set(['AVAILABLE', 'MISSING', 'DELETED', 'BLOCKED', 'FAILED']);
const SUBJECT_ROLES = new Set([...PROTECTIVE_ROLES, 'UNKNOWN', 'OTHER']);
const CONCLUSIONS = new Set([...ALLOWED_CONCLUSIONS, ...PROHIBITED_CONCLUSIONS]);

function parseEvidence(value, index) {
  const data = exactObject(value, EVIDENCE_REQUIRED, EVIDENCE_OPTIONAL, `evidence[${index}]`);
  return {
    evidence_id: stableRef(data.evidence_id, `evidence[${index}].evidence_id`),
    source_family_id: stableRef(data.source_family_id, `evidence[${index}].source_family_id`),
    provenance_root_id: stableRef(data.provenance_root_id, `evidence[${index}].provenance_root_id`),
    provenance_ref: stableRef(data.provenance_ref, `evidence[${index}].provenance_ref`),
    access_state: enumValue(data.access_state, ACCESS_STATES, `evidence[${index}].access_state`),
    source_reliability: enumValue(data.source_reliability, RELIABILITY, `evidence[${index}].source_reliability`),
    information_credibility: enumValue(data.information_credibility, RELIABILITY, `evidence[${index}].information_credibility`),
    supports_claims: enumList(data.supports_claims, CONCLUSIONS, `evidence[${index}].supports_claims`),
    subject_roles: enumList(data.subject_roles, SUBJECT_ROLES, `evidence[${index}].subject_roles`),
    act_specific: booleanValue(data.act_specific, `evidence[${index}].act_specific`),
    original_or_earliest_known: booleanValue(
      data.original_or_earliest_known,
      `evidence[${index}].original_or_earliest_known`,
    ),
    transformation_log_present: booleanValue(
      data.transformation_log_present,
      `evidence[${index}].transformation_log_present`,
    ),
  };
}

function parseAssessment(value) {
  const data = exactObject(value, ASSESSMENT_REQUIRED, ASSESSMENT_OPTIONAL, 'assessment');
  if (!Array.isArray(data.evidence) || data.evidence.length < 1 || data.evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new TypeError('evidence must be a non-empty bounded list');
  }
  return {
    assessment_id: stableRef(data.assessment_id, 'assessment_id'),
    subject_ref: stableRef(data.subject_ref, 'subject_ref'),
    attribution_level: enumValue(data.attribution_level, new Set(LEVEL_CONCLUSIONS.keys()), 'attribution_level'),
    requested_conclusion: enumValue(data.requested_conclusion, CONCLUSIONS, 'requested_conclusion'),
    requested_action: enumValue(data.requested_action, VALID_ACTIONS, 'requested_action', 'RESEARCH_ONLY'),
    evidence: data.evidence.map(parseEvidence),
    alternative_hypotheses: enumList(
      data.alternative_hypotheses,
      REQUIRED_INDIVIDUAL_ALTERNATIVES,
      'alternative_hypotheses',
    ),
    exculpatory_search_completed: booleanValue(
      data.exculpatory_search_completed,
      'exculpatory_search_completed',
    ),
    exculpatory_evidence_refs: stableRefList(data.exculpatory_evidence_refs, 'exculpatory_evidence_refs'),
    contrary_evidence_refs: stableRefList(data.contrary_evidence_refs, 'contrary_evidence_refs'),
    falsifiers: stableRefList(data.falsifiers, 'falsifiers'),
    assumptions: stableRefList(data.assumptions, 'assumptions'),
    uncertainties: stableRefList(data.uncertainties, 'uncertainties'),
    critical_gaps: stableRefList(data.critical_gaps, 'critical_gaps'),
    uses_missing_data_as_negative_evidence: booleanValue(
      data.uses_missing_data_as_negative_evidence,
      'uses_missing_data_as_negative_evidence',
    ),
    identity_resolution_checked: booleanValue(data.identity_resolution_checked, 'identity_resolution_checked'),
    peer_review_refs: stableRefList(data.peer_review_refs, 'peer_review_refs'),
    human_legal_review_ref:
      data.human_legal_review_ref === undefined
        ? null
        : stableRef(data.human_legal_review_ref, 'human_legal_review_ref'),
  };
}

function usableEvidence(item, conclusion) {
  return (
    item.access_state === 'AVAILABLE' &&
    ['MODERATE', 'HIGH'].includes(item.source_reliability) &&
    ['MODERATE', 'HIGH'].includes(item.information_credibility) &&
    item.transformation_log_present &&
    item.supports_claims.includes(conclusion)
  );
}

function unique(values) {
  return [...new Set(values)];
}

export function evaluatePublicAttributionEnvelope(value) {
  const payload = exactObject(value, new Set(['assessment']), new Set(), 'attribution payload');
  const assessment = parseAssessment(payload.assessment);
  const prohibited = [];
  const evidenceFailures = [];
  const reviewRequirements = [];

  if (PROHIBITED_CONCLUSIONS.has(assessment.requested_conclusion)) {
    prohibited.push('LABEL_REQUIRES_COMPETENT_HUMAN_LEGAL_AUTHORITY');
  }
  if (assessment.requested_action === 'TARGETING') prohibited.push('TARGETING_IS_OUTSIDE_SYSTEM_SCOPE');
  if (LEVEL_CONCLUSIONS.get(assessment.attribution_level) !== assessment.requested_conclusion) {
    evidenceFailures.push('CONCLUSION_DOES_NOT_MATCH_ATTRIBUTION_LEVEL');
  }

  const accepted = assessment.evidence.filter((item) => usableEvidence(item, assessment.requested_conclusion));
  const roots = new Set(accepted.map((item) => item.provenance_root_id));
  if (assessment.uses_missing_data_as_negative_evidence) {
    evidenceFailures.push('MISSING_OR_FAILED_ACCESS_IS_UNKNOWN_NOT_DISPROOF');
  }
  if (!accepted.length) evidenceFailures.push('NO_USABLE_CLAIM_SPECIFIC_EVIDENCE');

  if (['ACTOR_CLASS', 'ORGANIZATION', 'INDIVIDUAL'].includes(assessment.attribution_level)) {
    if (roots.size < 2) evidenceFailures.push('TWO_INDEPENDENT_PROVENANCE_ROOTS_MINIMUM');
    if (!assessment.alternative_hypotheses.length) evidenceFailures.push('COMPETING_HYPOTHESES_NOT_TESTED');
    if (!assessment.falsifiers.length) evidenceFailures.push('FALSIFIERS_NOT_DEFINED');
    if (!assessment.assumptions.length) evidenceFailures.push('KEY_ASSUMPTIONS_NOT_EXPLICIT');
    if (!assessment.uncertainties.length) evidenceFailures.push('UNCERTAINTIES_NOT_EXPLICIT');
  }

  if (['ORGANIZATION', 'INDIVIDUAL', 'FORMAL_STATUS'].includes(assessment.attribution_level)) {
    if (!assessment.identity_resolution_checked) evidenceFailures.push('IDENTITY_RESOLUTION_NOT_COMPLETED');
    reviewRequirements.push('HUMAN_REVIEW_REQUIRED_FOR_HIGH_IMPACT_ATTRIBUTION');
  }

  if (assessment.attribution_level === 'INDIVIDUAL') {
    if (!accepted.some((item) => item.act_specific)) evidenceFailures.push('NO_ACT_SPECIFIC_INDIVIDUAL_EVIDENCE');
    if (!assessment.exculpatory_search_completed) evidenceFailures.push('EXCULPATORY_SEARCH_NOT_COMPLETED');
    const alternatives = new Set(assessment.alternative_hypotheses);
    if ([...REQUIRED_INDIVIDUAL_ALTERNATIVES].some((item) => !alternatives.has(item))) {
      evidenceFailures.push('VICTIM_RESISTANCE_OR_FALSE_FLAG_ALTERNATIVES_MISSING');
    }
    if (assessment.critical_gaps.length) evidenceFailures.push('CRITICAL_GAPS_BLOCK_INDIVIDUAL_ATTRIBUTION');
    if (!assessment.peer_review_refs.length) reviewRequirements.push('INDEPENDENT_PEER_REVIEW_REQUIRED');
  }

  const protective = accepted.some((item) => item.subject_roles.some((role) => PROTECTIVE_ROLES.has(role)));
  if (protective && !accepted.some((item) => item.act_specific)) {
    evidenceFailures.push('VICTIM_WITNESS_OR_RESISTANCE_CONTENT_IS_NOT_PERPETRATOR_EVIDENCE');
  }

  if (assessment.requested_conclusion === 'OFFICIAL_SANCTIONS_DESIGNATION') {
    evidenceFailures.push('OFFICIAL_DESIGNATION_RECORD_REQUIRED');
  }
  if (['COMPLIANCE_HOLD', 'COMPLIANCE_BLOCK'].includes(assessment.requested_action)) {
    if (assessment.requested_conclusion !== 'OFFICIAL_SANCTIONS_DESIGNATION') {
      evidenceFailures.push('COMPLIANCE_ACTION_REQUIRES_CURRENT_OFFICIAL_RULE');
    }
    reviewRequirements.push('HUMAN_COMPLIANCE_REVIEW_REQUIRED');
  }
  if (assessment.requested_action === 'PUBLISH_PERSONAL_ATTRIBUTION') {
    reviewRequirements.push('EDITORIAL_AND_LEGAL_REVIEW_REQUIRED');
    if (new Set(assessment.peer_review_refs).size < 2) reviewRequirements.push('TWO_REVIEWERS_REQUIRED_FOR_PUBLICATION');
  }
  if (assessment.requested_action !== 'RESEARCH_ONLY' && !assessment.human_legal_review_ref) {
    reviewRequirements.push('HUMAN_LEGAL_REVIEW_NOT_YET_RECORDED');
  }

  let outcome;
  let nextStep;
  let reasons;
  if (prohibited.length) {
    outcome = 'PROHIBITED_AUTOMATED_CONCLUSION';
    nextStep = 'REFRAME_AS_A_CLAIM_SPECIFIC_LAWFUL_ASSESSMENT';
    reasons = [...prohibited, ...evidenceFailures, ...reviewRequirements];
  } else if (evidenceFailures.length) {
    outcome = 'INSUFFICIENT_EVIDENCE';
    nextStep = 'COLLECT_OR_VERIFY_MISSING_CLAIM_SPECIFIC_EVIDENCE';
    reasons = [...evidenceFailures, ...reviewRequirements];
  } else if (reviewRequirements.length) {
    outcome = 'HUMAN_REVIEW_REQUIRED';
    nextStep = 'SEND_EVIDENCE_PACKAGE_TO_AUTHORISED_HUMAN_REVIEW';
    reasons = reviewRequirements;
  } else {
    outcome = 'SUPPORTED_ANALYTIC_ASSESSMENT';
    nextStep = 'PRESERVE_PROVENANCE_AND_MONITOR_FALSIFIERS';
    reasons = ['ANALYTIC_GATE_PASSED_WITHOUT_ADVERSE_ACTION_AUTHORITY'];
  }

  const allHigh = accepted.length > 0 && accepted.every(
    (item) => item.source_reliability === 'HIGH' && item.information_credibility === 'HIGH',
  );
  const confidenceCap = roots.size >= 3 && allHigh && accepted.length === assessment.evidence.length && !assessment.critical_gaps.length
    ? 'HIGH'
    : roots.size >= 2
      ? 'MODERATE'
      : 'LOW';

  return {
    protocol_id: PROTOCOL_ID,
    runtime_profile: 'PUBLIC_SYNTHETIC_ONLY',
    outcome,
    reason_codes: unique(reasons),
    accepted_evidence_count: accepted.length,
    ignored_evidence_count: assessment.evidence.length - accepted.length,
    independent_provenance_roots: roots.size,
    confidence_cap: confidenceCap,
    automatic_adverse_action_allowed: false,
    next_step: nextStep,
    input_echoed: false,
    private_case_processing_allowed: false,
    model_output_counts_as_evidence: false,
  };
}

export const ai112AttributionGateMetadata = Object.freeze({
  protocol_id: PROTOCOL_ID,
  runtime_profile: 'PUBLIC_SYNTHETIC_ONLY',
  raw_content_fields_allowed: false,
  private_case_processing_allowed: false,
  automatic_adverse_action_allowed: false,
});
