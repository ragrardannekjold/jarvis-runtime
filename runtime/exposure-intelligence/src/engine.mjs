import path from "node:path";
import { authorizeAsset } from "./assets.mjs";
import { checkpointPath, loadCheckpoint, saveCheckpoint } from "./checkpoint.mjs";
import { circuitPath, circuitStatus, recordCircuitFailure, recordCircuitSuccess } from "./circuit.mjs";
import { appendEvidenceBatch, readEvidence, recoverEvidenceTail } from "./evidence.mjs";
import { ExposureError, invariant } from "./errors.mjs";
import { normalizeRecords } from "./normalize.mjs";
import { createCensysProvider } from "./providers/censys.mjs";
import { createNetlasProvider } from "./providers/netlas.mjs";
import { createShodanProvider } from "./providers/shodan.mjs";
import { DEFAULT_MAX_RESPONSE_BYTES } from "./http-response.mjs";
import { acquireDurableLock, runLockPath } from "./run-lock.mjs";
import { enforceObservationScope } from "./scope.mjs";
import { isoNow, sha256, stableStringify } from "./util.mjs";

function assetEqual(left, right) {
  return left?.type === right?.type && left?.value === right?.value;
}

function providersFor(selection) {
  if (selection === "auto") return ["shodan", "censys", "netlas"];
  return [selection];
}

function latestMatching(entries, kind, provider, queryHash) {
  return [...entries].reverse().find((entry) => (
    entry.kind === kind
    && entry.payload?.provider === provider
    && entry.payload?.queryHash === queryHash
  )) ?? null;
}

function unacknowledgedAmbiguity(entries, provider, queryHash) {
  const ambiguous = latestMatching(entries, "provider_ambiguous", provider, queryHash);
  if (!ambiguous) return null;
  const acknowledged = latestMatching(entries, "ambiguous_acknowledged", provider, queryHash);
  return !acknowledged || acknowledged.seq < ambiguous.seq ? ambiguous : null;
}

function pageCommitCore(payload) {
  return {
    provider: payload.provider,
    queryHash: payload.queryHash,
    asset: payload.asset,
    pageIndex: payload.pageIndex,
    cursor: payload.cursor,
    nextCursor: payload.nextCursor,
    rawHash: payload.rawHash,
    pageObservationCount: payload.pageObservationCount,
    observationSetHash: payload.observationSetHash,
    cumulativeObservationCount: payload.cumulativeObservationCount,
  };
}

function isValidPageCommit(entries, entryIndex) {
  const entry = entries[entryIndex];
  const payload = entry?.payload;
  if (entry?.kind !== "provider_page"
    || !Number.isInteger(payload?.pageObservationCount)
    || payload.pageObservationCount < 0
    || typeof payload?.observationSetHash !== "string"
    || payload.pageCommitId !== sha256(stableStringify(pageCommitCore(payload)))) {
    return false;
  }
  const firstObservation = entryIndex - payload.pageObservationCount;
  if (firstObservation < 0) return false;
  const pageObservations = entries.slice(firstObservation, entryIndex);
  if (pageObservations.length !== payload.pageObservationCount
    || pageObservations.some((candidate) => (
      candidate.kind !== "observation"
      || candidate.payload?.provider !== payload.provider
      || candidate.payload?.queryHash !== payload.queryHash
      || !assetEqual(candidate.payload?.asset, payload.asset)
      || typeof candidate.payload?.observationId !== "string"
    ))) {
    return false;
  }
  const observationIds = pageObservations.map((candidate) => candidate.payload.observationId).sort();
  return sha256(stableStringify(observationIds)) === payload.observationSetHash;
}

function recoveredPage(entries, provider, queryHash, asset) {
  const pages = entries.filter((entry, index) => (
    isValidPageCommit(entries, index)
    && entry.payload?.provider === provider
    && entry.payload?.queryHash === queryHash
    && assetEqual(entry.payload?.asset, asset)
  ));
  if (!pages.length) return null;
  return pages.sort((left, right) => right.payload.pageIndex - left.payload.pageIndex)[0];
}

function validateCheckpointEvidence(checkpoint, ledger) {
  if (!checkpoint) return;
  const hashes = new Set(ledger.entries.map((entry) => entry.hash));
  if (!checkpoint.evidenceHeadHash || !hashes.has(checkpoint.evidenceHeadHash)) {
    throw new ExposureError("Checkpoint evidence is missing from the verified append-only ledger.", {
      code: "CHECKPOINT_EVIDENCE_MISSING",
      failoverAllowed: false,
    });
  }
  if (checkpoint.pageIndex > 0) {
    const committed = ledger.entries.find((entry, index) => (
      isValidPageCommit(ledger.entries, index)
      && entry.payload?.provider === checkpoint.provider
      && entry.payload?.queryHash === checkpoint.queryHash
      && assetEqual(entry.payload?.asset, checkpoint.asset)
      && entry.payload?.pageIndex === checkpoint.pageIndex - 1
      && entry.payload?.cumulativeObservationCount === checkpoint.observationCount
    ));
    if (!committed) {
      throw new ExposureError("Checkpoint does not reference a fully committed provider page.", {
        code: "CHECKPOINT_PAGE_COMMIT_MISSING",
        failoverAllowed: false,
      });
    }
  }
}

function isLocalStateError(error) {
  return error instanceof ExposureError
    && /^(?:EVIDENCE_|CHECKPOINT_|RUN_LOCK)/.test(error.code);
}

export function createExposureEngine({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
  baseDir = process.cwd(),
  timeoutMs = 20_000,
  runLockStaleMs = 120_000,
  lockOwnerAlive = undefined,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const providers = {
    shodan: createShodanProvider({ fetchImpl, env, now, timeoutMs, maxResponseBytes }),
    censys: createCensysProvider({ fetchImpl, env, now, timeoutMs, maxResponseBytes }),
    netlas: createNetlasProvider({ fetchImpl, env, now, timeoutMs, maxResponseBytes }),
  };

  return {
    async collect({
      asset: rawAsset,
      allowlistPath,
      execute = false,
      provider = "auto",
      pageSize = 100,
      maxPages = 1,
      acknowledgeAmbiguous = false,
    }) {
      invariant(typeof execute === "boolean", "execute must be a boolean.", "INVALID_EXECUTE");
      invariant(["auto", "shodan", "censys", "netlas"].includes(provider), "Provider must be auto, shodan, censys, or netlas.", "INVALID_PROVIDER");
      invariant(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 50, "maxPages must be between 1 and 50.", "INVALID_MAX_PAGES");
      invariant(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100, "pageSize must be between 1 and 100.", "INVALID_PAGE_SIZE");
      const asset = await authorizeAsset(rawAsset, allowlistPath);
      const providerOrder = providersFor(provider);
      const plans = providerOrder.map((name) => providers[name].plan(asset, pageSize));
      if (!execute) {
        return {
          schemaVersion: 1,
          mode: "dry-run",
          networkRequests: 0,
          asset,
          providerOrder,
          plans: plans.map(({ provider: name, method, endpoint, query, queryHash, pageSize: size }) => ({
            provider: name,
            method,
            endpoint,
            query,
            queryHash,
            pageSize: size,
          })),
        };
      }

      const runLock = await acquireDurableLock(runLockPath(baseDir), {
        now,
        staleMs: runLockStaleMs,
        isOwnerAlive: lockOwnerAlive,
        purpose: "global-exposure-execute",
      });
      try {
        const evidencePath = path.join(baseDir, "evidence", "exposure.ndjson");
        const circuitsFile = circuitPath(baseDir);
        let lastError = null;

        await recoverEvidenceTail(evidencePath, { now });

        for (const name of providerOrder) {
        await runLock.heartbeat();
        const adapter = providers[name];
        const plan = adapter.plan(asset, pageSize);
        const checkpointFile = checkpointPath(baseDir, plan);
        const ledger = await readEvidence(evidencePath);
        const pendingAmbiguity = unacknowledgedAmbiguity(ledger.entries, name, plan.queryHash);
        let checkpoint = await loadCheckpoint(checkpointFile, { provider: name, queryHash: plan.queryHash, asset });
        validateCheckpointEvidence(checkpoint, ledger);
        const page = recoveredPage(ledger.entries, name, plan.queryHash, asset);
        if (page && (!checkpoint || page.payload.pageIndex >= checkpoint.pageIndex)) {
          checkpoint = await saveCheckpoint(checkpointFile, {
            provider: name,
            queryHash: plan.queryHash,
            asset,
            status: page.payload.nextCursor === null ? "COMPLETE" : "PAUSED",
            nextCursor: page.payload.nextCursor,
            pageIndex: page.payload.pageIndex + 1,
            observationCount: page.payload.cumulativeObservationCount,
            evidenceHeadHash: ledger.headHash,
            updatedAt: isoNow(now),
          });
        }
        if (provider === "auto" && checkpoint?.pageIndex > 0 && checkpoint.status !== "COMPLETE") {
          throw new ExposureError("Provider evidence is partial. Review it and resume the same provider explicitly; standby is blocked.", {
            code: "PARTIAL_PROVIDER_REVIEW_REQUIRED",
            failoverAllowed: false,
          });
        }
        if ((pendingAmbiguity || checkpoint?.status === "AMBIGUOUS") && !acknowledgeAmbiguous) {
          throw new ExposureError("A prior provider outcome is ambiguous. Review evidence, then explicitly acknowledge before retrying.", {
            code: "AMBIGUOUS_REVIEW_REQUIRED",
            ambiguous: true,
            details: { provider: name, evidenceSequence: pendingAmbiguity?.seq ?? null },
          });
        }
        if (pendingAmbiguity && acknowledgeAmbiguous) {
          await appendEvidenceBatch(evidencePath, [{
            kind: "ambiguous_acknowledged",
            payload: { provider: name, queryHash: plan.queryHash, asset, ambiguousSequence: pendingAmbiguity.seq },
          }], { now });
          checkpoint = checkpoint ? { ...checkpoint, status: "PAUSED", lastErrorCode: null } : checkpoint;
        }
        if (checkpoint?.status === "COMPLETE") {
          return {
            schemaVersion: 1,
            mode: "execute",
            status: "COMPLETE",
            provider: name,
            asset,
            queryHash: plan.queryHash,
            pagesRead: checkpoint.pageIndex,
            observationsWritten: checkpoint.observationCount,
            resumed: true,
            evidencePath,
            checkpointPath: checkpointFile,
          };
        }

        const circuit = await circuitStatus(circuitsFile, name, now);
        if (circuit.open) {
          await appendEvidenceBatch(evidencePath, [{
            kind: "provider_skipped_circuit",
            payload: { provider: name, queryHash: plan.queryHash, asset, openUntil: circuit.entry.openUntil, reason: circuit.entry.reason },
          }], { now });
          lastError = new ExposureError(`${name} circuit is open.`, {
            code: "PROVIDER_CIRCUIT_OPEN",
            failoverAllowed: provider === "auto",
            details: { provider: name, openUntil: circuit.entry.openUntil },
          });
          if (provider === "auto") continue;
          throw lastError;
        }

        let cursor = checkpoint?.nextCursor ?? (name === "netlas" ? 0 : name === "shodan" ? 1 : null);
        let pageIndex = checkpoint?.pageIndex ?? 0;
        let observationCount = checkpoint?.observationCount ?? 0;
        let pagesThisRun = 0;

        try {
          while (pagesThisRun < maxPages) {
            await runLock.heartbeat();
            const result = await adapter.requestPage({ asset, cursor, pageSize });
            await runLock.heartbeat();
            const fetchedAt = isoNow(now);
            const normalized = normalizeRecords({
              provider: name,
              records: result.records,
              queryHash: plan.queryHash,
              asset,
              fetchedAt,
              rawHash: result.rawHash,
            });
            const scoped = enforceObservationScope(normalized, asset);
            const observations = scoped.accepted;
            const observationIds = observations.map((observation) => observation.observationId).sort();
            const observationSetHash = sha256(stableStringify(observationIds));
            const cumulativeObservationCount = observationCount + observations.length;
            const commitCore = {
              provider: name,
              queryHash: plan.queryHash,
              asset,
              pageIndex,
              cursor,
              nextCursor: result.nextCursor,
              rawHash: result.rawHash,
              pageObservationCount: observations.length,
              observationSetHash,
              cumulativeObservationCount,
            };
            const pageCommitId = sha256(stableStringify(commitCore));
            const additions = [...observations.map((observation) => ({ kind: "observation", payload: observation })), {
              kind: "provider_page",
              payload: {
                provider: name,
                queryHash: plan.queryHash,
                asset,
                pageIndex,
                cursor,
                nextCursor: result.nextCursor,
                rawHash: result.rawHash,
                pageCommitId,
                pageObservationCount: observations.length,
                observationSetHash,
                droppedOutOfScopeCount: scoped.dropped,
                cumulativeObservationCount,
                meta: result.meta,
              },
            }];
            const appended = await appendEvidenceBatch(evidencePath, additions, { now });
            observationCount = cumulativeObservationCount;
            cursor = result.nextCursor;
            pageIndex += 1;
            pagesThisRun += 1;
            checkpoint = await saveCheckpoint(checkpointFile, {
              provider: name,
              queryHash: plan.queryHash,
              asset,
              status: cursor === null ? "COMPLETE" : "PAUSED",
              nextCursor: cursor,
              pageIndex,
              observationCount,
              evidenceHeadHash: appended.headHash,
              updatedAt: isoNow(now),
            });
            await recordCircuitSuccess(circuitsFile, name, now);
            if (cursor === null) break;
          }
          return {
            schemaVersion: 1,
            mode: "execute",
            status: cursor === null ? "COMPLETE" : "PAUSED",
            provider: name,
            asset,
            queryHash: plan.queryHash,
            pagesRead: pageIndex,
            pagesThisRun,
            observationsWritten: observationCount,
            resumed: Boolean(checkpoint && pageIndex > pagesThisRun),
            nextCursor: cursor,
            evidencePath,
            checkpointPath: checkpointFile,
          };
        } catch (error) {
          if (isLocalStateError(error)) throw error;
          const providerError = error instanceof ExposureError
            ? error
            : new ExposureError("Unexpected provider adapter error.", { code: "PROVIDER_ADAPTER_ERROR", cause: error });
          const kind = providerError.ambiguous ? "provider_ambiguous" : "provider_failure";
          const appended = await appendEvidenceBatch(evidencePath, [{
            kind,
            payload: {
              provider: name,
              queryHash: plan.queryHash,
              asset,
              pageIndex,
              cursor,
              errorCode: providerError.code,
              status: providerError.status,
              retryAfterMs: providerError.retryAfterMs,
              creditAccounting: providerError.details?.creditAccounting ?? null,
              queryCreditsBefore: providerError.details?.queryCreditsBefore ?? null,
            },
          }], { now });
          await saveCheckpoint(checkpointFile, {
            provider: name,
            queryHash: plan.queryHash,
            asset,
            status: providerError.ambiguous ? "AMBIGUOUS" : "FAILED",
            nextCursor: cursor,
            pageIndex,
            observationCount,
            evidenceHeadHash: appended.headHash,
            lastErrorCode: providerError.code,
            updatedAt: isoNow(now),
          });
          await recordCircuitFailure(circuitsFile, name, providerError, now);
          if (providerError.ambiguous) throw providerError;
          if (pagesThisRun > 0 || pageIndex > 0) {
            throw new ExposureError("Provider failed after partial evidence was committed; automatic mixing with standby is blocked.", {
              code: "PARTIAL_PROVIDER_REVIEW_REQUIRED",
              failoverAllowed: false,
              cause: providerError,
            });
          }
          lastError = providerError;
          if (provider === "auto" && providerError.failoverAllowed) continue;
          throw providerError;
        }
        }
        throw lastError ?? new ExposureError("No configured provider could execute the authorized read.", { code: "NO_PROVIDER_AVAILABLE" });
      } finally {
        await runLock.release();
      }
    },
  };
}
