import { chmod, open, readFile } from "node:fs/promises";
import path from "node:path";
import { ExposureError } from "./errors.mjs";
import { withDurableLock } from "./run-lock.mjs";
import { atomicWriteFile, ensurePrivateDir, fsyncDirectory, isoNow, redact, sha256, stableStringify } from "./util.mjs";

function entryCore({ seq, previousHash, recordedAt, kind, payload }) {
  return { schemaVersion: 1, seq, previousHash, recordedAt, kind, payload };
}

function parseLedger(text) {
  if (!text.trim()) return [];
  return text.trimEnd().split("\n").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (cause) {
      throw new ExposureError(`Evidence line ${index + 1} is invalid JSON.`, { code: "EVIDENCE_INVALID", cause });
    }
  });
}

export function verifyEntries(entries) {
  let previousHash = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.seq !== index + 1 || entry.previousHash !== previousHash) {
      throw new ExposureError(`Evidence chain breaks at sequence ${index + 1}.`, { code: "EVIDENCE_CHAIN_BROKEN" });
    }
    const core = entryCore(entry);
    const expected = sha256(stableStringify(core));
    if (entry.hash !== expected) {
      throw new ExposureError(`Evidence hash mismatch at sequence ${index + 1}.`, { code: "EVIDENCE_HASH_MISMATCH" });
    }
    previousHash = entry.hash;
  }
  return { valid: true, count: entries.length, headHash: previousHash };
}

export async function readEvidence(evidencePath) {
  let text = "";
  try {
    text = await readFile(evidencePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = parseLedger(text);
  const verification = verifyEntries(entries);
  return { entries, ...verification };
}

async function recoverTailLocked(evidencePath) {
  let raw;
  try {
    raw = await readFile(evidencePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return null;

  const lastNewline = raw.lastIndexOf(0x0a);
  const prefix = lastNewline >= 0 ? raw.subarray(0, lastNewline + 1) : Buffer.alloc(0);
  const fragment = raw.subarray(lastNewline + 1);
  verifyEntries(parseLedger(prefix.toString("utf8")));

  const fragmentHash = sha256(fragment);
  const quarantineDir = `${evidencePath}.quarantine`;
  await ensurePrivateDir(quarantineDir);
  const quarantineFile = path.join(quarantineDir, `tail-${fragmentHash}.fragment`);
  await atomicWriteFile(quarantineFile, fragment, 0o600);
  await atomicWriteFile(evidencePath, prefix, 0o600);
  return {
    kind: "evidence_tail_recovered",
    payload: {
      fragmentHash,
      fragmentBytes: fragment.byteLength,
      quarantineFile: path.basename(quarantineFile),
    },
  };
}

async function appendLocked(evidencePath, additions, now) {
  const existing = await readEvidence(evidencePath);
  let seq = existing.count;
  let previousHash = existing.headHash;
  const entries = additions.map(({ kind, payload }) => {
    seq += 1;
    const core = entryCore({
      seq,
      previousHash,
      recordedAt: isoNow(now),
      kind,
      payload: redact(payload),
    });
    const entry = { ...core, hash: sha256(stableStringify(core)) };
    previousHash = entry.hash;
    return entry;
  });
  await ensurePrivateDir(path.dirname(evidencePath));
  const handle = await open(evidencePath, "a", 0o600);
  try {
    await chmod(evidencePath, 0o600);
    await handle.writeFile(entries.map((entry) => `${stableStringify(entry)}\n`).join(""), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(evidencePath));
  return { valid: true, count: seq, headHash: previousHash, appended: entries };
}

function evidenceLockOptions(now, lockStaleMs) {
  return {
    now,
    staleMs: lockStaleMs,
    purpose: "evidence",
    lockedCode: "EVIDENCE_LOCKED",
    ownershipLostCode: "EVIDENCE_LOCK_OWNERSHIP_LOST",
    cleanupCode: "EVIDENCE_LOCK_CLEANUP_FAILED",
  };
}

export async function recoverEvidenceTail(evidencePath, { now = Date.now, lockStaleMs = 120_000 } = {}) {
  const lockPath = `${evidencePath}.lock`;
  return withDurableLock(lockPath, async () => {
    const recovery = await recoverTailLocked(evidencePath);
    if (!recovery) return readEvidence(evidencePath);
    return appendLocked(evidencePath, [recovery], now);
  }, evidenceLockOptions(now, lockStaleMs));
}

export async function appendEvidenceBatch(evidencePath, additions, { now = Date.now, lockStaleMs = 120_000 } = {}) {
  if (!Array.isArray(additions) || additions.length === 0) return readEvidence(evidencePath);
  const lockPath = `${evidencePath}.lock`;
  return withDurableLock(lockPath, async () => {
    const recovery = await recoverTailLocked(evidencePath);
    return appendLocked(evidencePath, recovery ? [recovery, ...additions] : additions, now);
  }, evidenceLockOptions(now, lockStaleMs));
}

export async function verifyEvidence(evidencePath) {
  const result = await readEvidence(evidencePath);
  return { valid: result.valid, count: result.count, headHash: result.headHash };
}
