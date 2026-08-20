import path from "node:path";
import { ExposureError } from "./errors.mjs";
import { atomicWriteJson, readJson, sha256, stableStringify } from "./util.mjs";

export function checkpointPath(baseDir, plan) {
  return path.join(baseDir, ".state", "checkpoints", `${plan.provider}-${plan.queryHash}.json`);
}

export async function loadCheckpoint(filePath, { provider, queryHash, asset }) {
  const checkpoint = await readJson(filePath, null);
  if (!checkpoint) return null;
  const binding = sha256(stableStringify({ provider, queryHash, asset }));
  if (checkpoint.binding !== binding) {
    throw new ExposureError("Checkpoint binding does not match this provider query.", { code: "CHECKPOINT_BINDING_MISMATCH" });
  }
  return checkpoint;
}

export async function saveCheckpoint(filePath, checkpoint) {
  const binding = sha256(stableStringify({
    provider: checkpoint.provider,
    queryHash: checkpoint.queryHash,
    asset: checkpoint.asset,
  }));
  const document = {
    schemaVersion: 1,
    binding,
    provider: checkpoint.provider,
    queryHash: checkpoint.queryHash,
    asset: checkpoint.asset,
    status: checkpoint.status,
    nextCursor: checkpoint.nextCursor ?? null,
    pageIndex: checkpoint.pageIndex ?? 0,
    observationCount: checkpoint.observationCount ?? 0,
    evidenceHeadHash: checkpoint.evidenceHeadHash ?? null,
    lastErrorCode: checkpoint.lastErrorCode ?? null,
    updatedAt: checkpoint.updatedAt,
  };
  await atomicWriteJson(filePath, document, 0o600);
  return document;
}
