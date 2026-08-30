#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { loadCatalog, searchCatalog } from "../../plugin/utility-search/lib/catalog.js";

const MAX_INPUT_BYTES = 8 * 1024;
const ALLOWED_KEYS = new Set(["query", "limit"]);

function fail(code) {
  process.stdout.write(`${JSON.stringify({ error_code: code })}\n`);
  process.exitCode = 1;
}

try {
  const raw = readFileSync(0);
  if (raw.byteLength > MAX_INPUT_BYTES) throw new Error("INPUT_TOO_LARGE");
  const request = JSON.parse(raw.toString("utf8"));
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("INVALID_INPUT");
  if (Object.keys(request).some((key) => !ALLOWED_KEYS.has(key)) || Object.keys(request).length !== 2) {
    throw new Error("INPUT_FIELDS_NOT_ALLOWLISTED");
  }
  if (typeof request.query !== "string" || !request.query.trim()) throw new Error("INVALID_QUERY");
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 20) throw new Error("INVALID_LIMIT");

  const matches = searchCatalog(loadCatalog({}), request.query, request.limit).map((utility) => ({
    id: utility.id,
    name: utility.name,
    url: utility.url,
    score: utility._score,
    cost_class: utility.cost?.class ?? null,
    max_usd_per_run: utility.cost?.max_usd_per_run ?? null,
    risk_mode: utility.risk?.mode ?? null,
    confirmation_required: utility.risk?.confirmation_required ?? null,
    health: utility.status?.health ?? null,
  }));
  const output = {
    schema_version: 1,
    executor_id: "utility-search.local-catalog",
    capability: "utility.catalog.search",
    terminal_class: "SUCCESS",
    effect_observation: "NO_EXTERNAL_EFFECT",
    quality_score: 1,
    evidence_refs: ["plugin/utility-search/lib/catalog.js", "plugin/utility-search/lib/public-catalog.js"],
    output: {
      query: request.query.trim(),
      match_count: matches.length,
      matches,
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  fail(typeof error?.message === "string" && /^[A-Z0-9_]{3,80}$/.test(error.message) ? error.message : "EXECUTOR_FAILED");
}
