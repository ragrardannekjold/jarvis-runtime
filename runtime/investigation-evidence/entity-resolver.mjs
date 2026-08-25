import { createHash } from "node:crypto";

const LEGAL_FORM_TOKENS = new Set([
  "ооо", "оао", "пао", "ао", "зао", "нко", "ип",
  "тов", "тзов", "прат", "ат", "фоп",
  "llc", "ltd", "limited", "inc", "incorporated", "corp", "corporation",
  "jsc", "pjsc", "plc", "gmbh", "ag",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeJurisdiction(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 64) throw new Error("invalid_jurisdiction");
  const normalized = value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, " ");
  return normalized || null;
}

export function normalizeTaxId(value) {
  if (value === undefined || value === null || value === "") return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 16) throw new Error("invalid_tax_id");
  return digits;
}

export function normalizeDomain(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 253) throw new Error("invalid_domain");
  const raw = value.includes("://") ? value : `https://${value}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("invalid_domain");
  }
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error("invalid_domain");
  return parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function normalizeEntityName(value) {
  if (typeof value !== "string" || value.trim().length < 2 || value.length > 512) {
    throw new Error("invalid_entity_name");
  }
  const tokens = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[«»“”„‟\"'`´’‘()[\]{}.,:;!?/\\|+*=<>—–_-]+/g, " ")
    .replace(/&/g, " and ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !LEGAL_FORM_TOKENS.has(token));
  const normalized = tokens.join(" ").trim();
  if (normalized.length < 2) throw new Error("entity_name_empty_after_normalization");
  return normalized;
}

function normalizeSourceRef(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) throw new Error("invalid_source_ref");
  return value.trim() || null;
}

function normalizeRecord(record, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid_entity_record");
  const name = normalizeEntityName(record.name);
  const jurisdiction = normalizeJurisdiction(record.jurisdiction);
  const taxId = normalizeTaxId(record.tax_id);
  const domain = normalizeDomain(record.domain);
  const sourceRef = normalizeSourceRef(record.source_ref);
  return {
    index,
    raw_name: record.name.trim(),
    normalized_name: name,
    jurisdiction,
    tax_id: taxId,
    domain,
    source_ref: sourceRef,
  };
}

function matchKeys(record) {
  const keys = [];
  if (record.tax_id) keys.push(`tax:${record.jurisdiction || "?"}:${record.tax_id}`);
  if (record.domain) keys.push(`domain:${record.domain}`);
  if (record.jurisdiction && record.normalized_name.length >= 4) {
    keys.push(`name:${record.jurisdiction}:${record.normalized_name}`);
  }
  return keys;
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = Array(size).fill(0);
  }

  find(value) {
    if (this.parent[value] !== value) this.parent[value] = this.find(this.parent[value]);
    return this.parent[value];
  }

  union(left, right) {
    let a = this.find(left);
    let b = this.find(right);
    if (a === b) return;
    if (this.rank[a] < this.rank[b]) [a, b] = [b, a];
    this.parent[b] = a;
    if (this.rank[a] === this.rank[b]) this.rank[a] += 1;
  }
}

function canonicalMember(members) {
  return [...members].sort((a, b) => {
    const scoreA = (a.tax_id ? 8 : 0) + (a.domain ? 4 : 0) + (a.jurisdiction ? 2 : 0) + Math.min(a.raw_name.length, 100) / 1000;
    const scoreB = (b.tax_id ? 8 : 0) + (b.domain ? 4 : 0) + (b.jurisdiction ? 2 : 0) + Math.min(b.raw_name.length, 100) / 1000;
    return scoreB - scoreA || a.index - b.index;
  })[0];
}

export function resolveEntities(records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > 10_000) {
    throw new Error("entity_records_required");
  }
  const normalized = records.map(normalizeRecord);
  const uf = new UnionFind(normalized.length);
  const keyOwner = new Map();

  for (const record of normalized) {
    for (const key of matchKeys(record)) {
      if (keyOwner.has(key)) uf.union(record.index, keyOwner.get(key));
      else keyOwner.set(key, record.index);
    }
  }

  const groups = new Map();
  for (const record of normalized) {
    const root = uf.find(record.index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(record);
  }

  const clusters = [...groups.values()].map((members) => {
    const canonical = canonicalMember(members);
    const keys = [...new Set(members.flatMap(matchKeys))].sort();
    const aliases = [...new Set(members.map((member) => member.raw_name))].sort((a, b) => a.localeCompare(b));
    const sourceRefs = [...new Set(members.map((member) => member.source_ref).filter(Boolean))].sort();
    const stableSeed = keys.length > 0
      ? keys.join("|")
      : `${canonical.jurisdiction || "?"}|${canonical.normalized_name}`;
    return {
      cluster_id: `entity_${sha256(stableSeed).slice(0, 16)}`,
      canonical: {
        name: canonical.raw_name,
        normalized_name: canonical.normalized_name,
        jurisdiction: canonical.jurisdiction,
        tax_id: canonical.tax_id,
        domain: canonical.domain,
      },
      aliases,
      source_refs: sourceRefs,
      match_keys: keys,
      member_count: members.length,
    };
  });

  return clusters.sort((a, b) => a.cluster_id.localeCompare(b.cluster_id));
}
