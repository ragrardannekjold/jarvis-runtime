import path from "node:path";
import { atomicWriteJson, isoNow, readJson } from "./util.mjs";

const SETTINGS = {
  shodan: { transientThreshold: 2, transientCooldownMs: 30_000, authCooldownMs: 300_000 },
  censys: { transientThreshold: 2, transientCooldownMs: 30_000, authCooldownMs: 300_000 },
  netlas: { transientThreshold: 2, transientCooldownMs: 60_000, authCooldownMs: 300_000 },
};

export function circuitPath(baseDir) {
  return path.join(baseDir, ".state", "circuits.json");
}

async function loadState(filePath) {
  return await readJson(filePath, { schemaVersion: 1, providers: {} });
}

export async function circuitStatus(filePath, provider, now = Date.now) {
  const state = await loadState(filePath);
  const entry = state.providers?.[provider] ?? null;
  const current = typeof now === "function" ? now() : now;
  return {
    open: Boolean(entry?.openUntil && Date.parse(entry.openUntil) > current),
    entry,
  };
}

export async function recordCircuitSuccess(filePath, provider, now = Date.now) {
  const state = await loadState(filePath);
  state.providers[provider] = {
    consecutiveFailures: 0,
    openUntil: null,
    reason: null,
    updatedAt: isoNow(now),
  };
  await atomicWriteJson(filePath, state, 0o600);
}

export async function recordCircuitFailure(filePath, provider, error, now = Date.now) {
  if (error.ambiguous || error.code?.endsWith("CREDENTIAL_MISSING")) return;
  const state = await loadState(filePath);
  const settings = SETTINGS[provider];
  const prior = state.providers[provider] ?? { consecutiveFailures: 0 };
  const failures = (prior.consecutiveFailures ?? 0) + 1;
  const current = typeof now === "function" ? now() : now;
  const isRate = error.code?.includes("RATE_LIMITED");
  const isAuth = error.code?.includes("AUTH_OR_ENTITLEMENT") || error.code?.includes("CREDITS_UNAVAILABLE");
  let cooldownMs = 0;
  if (isRate) cooldownMs = error.retryAfterMs ?? 60_000;
  else if (isAuth) cooldownMs = settings.authCooldownMs;
  else if (failures >= settings.transientThreshold) cooldownMs = error.retryAfterMs ?? settings.transientCooldownMs;
  state.providers[provider] = {
    consecutiveFailures: failures,
    openUntil: cooldownMs > 0 ? new Date(current + cooldownMs).toISOString() : null,
    reason: error.code,
    updatedAt: isoNow(now),
  };
  await atomicWriteJson(filePath, state, 0o600);
}
