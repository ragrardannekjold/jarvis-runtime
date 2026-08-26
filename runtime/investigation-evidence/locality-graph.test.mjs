import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalityEvidenceGraph } from './locality-graph.mjs';

test('finds shared actors across localities and observed funding gaps', () => {
  const result = buildLocalityEvidenceGraph({
    window: { start: '2026-03-01', end: '2026-08-26' },
    nodes: [
      { id: 'loc:bakhmut', type: 'locality', label: 'Bakhmut' },
      { id: 'loc:soledar', type: 'locality', label: 'Soledar' },
      { id: 'org:x', type: 'organization', label: 'X' },
      { id: 'org:source', type: 'organization', label: 'Source' },
      { id: 'org:sink', type: 'organization', label: 'Sink' },
    ],
    edges: [
      { from: 'org:x', to: 'loc:bakhmut', type: 'OPERATES_AT', event_date: '2026-06-01', confidence: 8, evidence_ids: ['ev1'] },
      { from: 'org:x', to: 'loc:soledar', type: 'CONTRACTED_AT', event_date: '2026-07-01', confidence: 7, evidence_ids: ['ev2'] },
      { from: 'org:source', to: 'org:x', type: 'FUNDS_IN', event_date: '2026-06-05', confidence: 9, amount: 100 },
      { from: 'org:x', to: 'org:sink', type: 'FUNDS_OUT', event_date: '2026-06-06', confidence: 9, amount: 250 },
    ],
  });

  assert.equal(result.shared_actors.length, 1);
  assert.deepEqual(result.shared_actors[0].localities, ['loc:bakhmut', 'loc:soledar']);
  assert.equal(result.shared_actors[0].locality_count, 2);
  assert.deepEqual(result.shared_actors[0].evidence_ids, ['ev1', 'ev2']);
  assert.equal(result.unexplained_observed_funding.length, 1);
  assert.equal(result.unexplained_observed_funding[0].entity_id, 'org:x');
  assert.equal(result.unexplained_observed_funding[0].unexplained_observed_gap, 150);
});

test('excludes stale edges outside the analysis window', () => {
  const result = buildLocalityEvidenceGraph({
    window: { start: '2026-03-01', end: '2026-08-26' },
    nodes: [
      { id: 'loc:bakhmut', type: 'locality', label: 'Bakhmut' },
      { id: 'loc:soledar', type: 'locality', label: 'Soledar' },
      { id: 'org:x', type: 'organization', label: 'X' },
    ],
    edges: [
      { from: 'org:x', to: 'loc:bakhmut', type: 'OPERATES_AT', event_date: '2025-12-01', confidence: 9 },
      { from: 'org:x', to: 'loc:soledar', type: 'OPERATES_AT', event_date: '2026-07-01', confidence: 9 },
    ],
  });

  assert.equal(result.active_edge_count, 1);
  assert.equal(result.shared_actors.length, 0);
});

test('rejects unknown node references', () => {
  assert.throws(() => buildLocalityEvidenceGraph({
    window: { start: '2026-03-01', end: '2026-08-26' },
    nodes: [{ id: 'org:x', type: 'organization', label: 'X' }],
    edges: [{ from: 'org:x', to: 'loc:missing', type: 'OPERATES_AT', event_date: '2026-07-01', confidence: 9 }],
  }), /edge_references_unknown_node/);
});
