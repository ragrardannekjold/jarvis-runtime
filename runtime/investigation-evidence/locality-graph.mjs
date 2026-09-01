function assertArray(value, name, max = 100_000) {
  if (!Array.isArray(value)) throw new Error(`${name}_must_be_array`);
  if (value.length > max) throw new Error(`${name}_too_large`);
}

function isoDay(value, field) {
  if (typeof value !== 'string') throw new Error(`invalid_${field}`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid_${field}`);
  return d.toISOString().slice(0, 10);
}

function withinWindow(date, startDay, endDay) {
  const day = isoDay(date, 'event_date');
  return day >= startDay && day <= endDay;
}

function uniq(values) {
  return [...new Set(values)].sort();
}

export function buildLocalityEvidenceGraph({ nodes, edges, window }) {
  assertArray(nodes, 'nodes');
  assertArray(edges, 'edges');
  if (!window || typeof window !== 'object') throw new Error('window_required');
  const startDay = isoDay(window.start, 'window_start');
  const endDay = isoDay(window.end, 'window_end');
  if (startDay > endDay) throw new Error('invalid_window_order');

  const nodeById = new Map();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('invalid_node');
    if (typeof node.id !== 'string' || !node.id.trim()) throw new Error('invalid_node_id');
    if (nodeById.has(node.id)) throw new Error('duplicate_node_id');
    if (typeof node.type !== 'string' || !node.type.trim()) throw new Error('invalid_node_type');
    nodeById.set(node.id, { ...node });
  }

  const activeEdges = [];
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new Error('invalid_edge');
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) throw new Error('edge_references_unknown_node');
    if (typeof edge.type !== 'string' || !edge.type.trim()) throw new Error('invalid_edge_type');
    if (!withinWindow(edge.event_date, startDay, endDay)) continue;
    const confidence = Number(edge.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 10) throw new Error('invalid_edge_confidence');
    activeEdges.push({
      ...edge,
      confidence,
      evidence_ids: uniq(Array.isArray(edge.evidence_ids) ? edge.evidence_ids.filter((x) => typeof x === 'string' && x) : []),
      event_date: isoDay(edge.event_date, 'event_date'),
    });
  }

  const localityIds = new Set([...nodeById.values()].filter((n) => n.type === 'locality').map((n) => n.id));
  const organizationTypes = new Set(['organization', 'company', 'fop', 'institution', 'contractor']);
  const organizationIds = new Set([...nodeById.values()].filter((n) => organizationTypes.has(n.type)).map((n) => n.id));

  const actorLocalities = new Map();
  const actorEvidence = new Map();
  const acceptedRelationTypes = new Set([
    'OPERATES_AT', 'CONTRACTED_AT', 'SUPPLIED_AT', 'REGISTERED_AT', 'SERVICES', 'PROCUREMENT_SITE',
  ]);

  for (const edge of activeEdges) {
    if (!acceptedRelationTypes.has(edge.type)) continue;
    let actorId = null;
    let localityId = null;
    if (organizationIds.has(edge.from) && localityIds.has(edge.to)) {
      actorId = edge.from;
      localityId = edge.to;
    } else if (organizationIds.has(edge.to) && localityIds.has(edge.from)) {
      actorId = edge.to;
      localityId = edge.from;
    }
    if (!actorId) continue;
    if (!actorLocalities.has(actorId)) actorLocalities.set(actorId, new Set());
    actorLocalities.get(actorId).add(localityId);
    if (!actorEvidence.has(actorId)) actorEvidence.set(actorId, new Set());
    for (const id of edge.evidence_ids) actorEvidence.get(actorId).add(id);
  }

  const sharedActors = [...actorLocalities.entries()]
    .filter(([, locs]) => locs.size >= 2)
    .map(([actor_id, locs]) => ({
      actor_id,
      localities: [...locs].sort(),
      locality_count: locs.size,
      evidence_ids: [...(actorEvidence.get(actor_id) || [])].sort(),
    }))
    .sort((a, b) => b.locality_count - a.locality_count || a.actor_id.localeCompare(b.actor_id));

  const cashflowTypes = new Set(['FUNDS_IN', 'FUNDS_OUT']);
  const funding = new Map();
  for (const edge of activeEdges) {
    if (!cashflowTypes.has(edge.type)) continue;
    const amount = Number(edge.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('invalid_cashflow_amount');
    const entityId = edge.type === 'FUNDS_IN' ? edge.to : edge.from;
    if (!organizationIds.has(entityId)) continue;
    if (!funding.has(entityId)) funding.set(entityId, { inflow: 0, outflow: 0, inflow_edges: [], outflow_edges: [] });
    const row = funding.get(entityId);
    if (edge.type === 'FUNDS_IN') {
      row.inflow += amount;
      row.inflow_edges.push(edge);
    } else {
      row.outflow += amount;
      row.outflow_edges.push(edge);
    }
  }

  const unexplainedObservedFunding = [...funding.entries()]
    .map(([entity_id, row]) => {
      const gap = row.outflow - row.inflow;
      return {
        entity_id,
        observed_inflow: row.inflow,
        observed_outflow: row.outflow,
        unexplained_observed_gap: gap > 0 ? gap : 0,
        note: 'Open-source accounting gap only; this does not identify a hidden donor or funding source.',
      };
    })
    .filter((row) => row.unexplained_observed_gap > 0)
    .sort((a, b) => b.unexplained_observed_gap - a.unexplained_observed_gap || a.entity_id.localeCompare(b.entity_id));

  return {
    window: { start: startDay, end: endDay },
    node_count: nodeById.size,
    active_edge_count: activeEdges.length,
    shared_actors: sharedActors,
    unexplained_observed_funding: unexplainedObservedFunding,
  };
}
