import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ExposureError } from "./errors.mjs";
import { ensurePrivateDir, isoNow, sha256, stableStringify } from "./util.mjs";

async function processStartMarker(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = statLine.lastIndexOf(")");
    if (close < 0) return null;
    const afterCommand = statLine.slice(close + 1).trim().split(/\s+/);
    return afterCommand[19] ?? null;
  } catch {
    return null;
  }
}

export async function defaultOwnerAlive(owner) {
  if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return null;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
  if (owner.processStartMarker) {
    const currentMarker = await processStartMarker(owner.pid);
    if (currentMarker && currentMarker !== owner.processStartMarker) return false;
  }
  return true;
}

async function readOwner(lockPath) {
  const info = await lstat(lockPath);
  const ownerPath = info.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    if (info.isDirectory()) {
      try {
        const heartbeatInfo = await lstat(path.join(lockPath, "heartbeat"));
        owner.heartbeatAt = new Date(heartbeatInfo.mtimeMs).toISOString();
      } catch {
        // Preserve the owner timestamp for old or crash-interrupted locks.
      }
    }
    return { owner, info };
  } catch {
    return { owner: null, info };
  }
}

function lockError(message, code, lockPath, owner = null, cause = undefined) {
  return new ExposureError(message, {
    code,
    failoverAllowed: false,
    details: {
      lockPath,
      ownerPid: owner?.pid ?? null,
      heartbeatAt: owner?.heartbeatAt ?? null,
    },
    cause,
  });
}

export function runLockPath(baseDir) {
  return path.join(baseDir, ".state", "run-locks", "global-execute.lock");
}

export async function acquireDurableLock(lockPath, {
  now = Date.now,
  staleMs = 120_000,
  ownerToken = randomUUID(),
  pid = process.pid,
  hostname = os.hostname(),
  isOwnerAlive = defaultOwnerAlive,
  purpose = "run",
  lockedCode = "RUN_LOCKED",
  ownershipLostCode = "RUN_LOCK_OWNERSHIP_LOST",
  cleanupCode = "RUN_LOCK_CLEANUP_FAILED",
} = {}) {
  await ensurePrivateDir(path.dirname(lockPath));
  const startedAt = isoNow(now);
  const owner = {
    schemaVersion: 1,
    ownerToken,
    pid,
    hostname,
    processStartMarker: await processStartMarker(pid),
    purpose,
    startedAt,
    heartbeatAt: startedAt,
  };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const ownerPath = path.join(lockPath, "owner.json");
      await writeFile(ownerPath, `${stableStringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(ownerPath, 0o600);
      const heartbeatPath = path.join(lockPath, "heartbeat");
      await writeFile(heartbeatPath, `${ownerToken}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(heartbeatPath, 0o600);
      const heartbeatDate = new Date(typeof now === "function" ? now() : now);
      await utimes(heartbeatPath, heartbeatDate, heartbeatDate);
      let released = false;
      return {
        lockPath,
        ownerToken,
        async heartbeat() {
          if (released) throw lockError("Cannot heartbeat a released lock.", ownershipLostCode, lockPath);
          let handle;
          try {
            handle = await open(path.join(lockPath, "heartbeat"), "r");
            const heartbeatToken = (await handle.readFile("utf8")).trim();
            if (heartbeatToken !== ownerToken) {
              throw lockError("Lock ownership was lost.", ownershipLostCode, lockPath);
            }
            const at = new Date(typeof now === "function" ? now() : now);
            await handle.utimes(at, at);
            await handle.sync();
          } catch (error) {
            if (error instanceof ExposureError) throw error;
            throw lockError("Lock ownership was lost.", ownershipLostCode, lockPath, null, error);
          } finally {
            await handle?.close();
          }
          const current = await readOwner(lockPath).catch((error) => {
            throw lockError("Lock ownership was lost.", ownershipLostCode, lockPath, null, error);
          });
          if (current.owner?.ownerToken !== ownerToken) {
            throw lockError("Lock ownership was lost.", ownershipLostCode, lockPath, current.owner);
          }
        },
        async release() {
          if (released) return;
          let current;
          try {
            current = await readOwner(lockPath);
          } catch (error) {
            if (error?.code === "ENOENT") {
              throw lockError("Lock directory disappeared before release.", ownershipLostCode, lockPath);
            }
            throw error;
          }
          if (current.owner?.ownerToken !== ownerToken) {
            throw lockError("Lock ownership changed before release.", ownershipLostCode, lockPath, current.owner);
          }
          const releasedPath = `${lockPath}.released-${sha256(ownerToken).slice(0, 24)}`;
          await rename(lockPath, releasedPath);
          released = true;
          const moved = await readOwner(releasedPath).catch((error) => {
            throw lockError("Moved lock could not be verified before cleanup.", ownershipLostCode, releasedPath, null, error);
          });
          if (moved.owner?.ownerToken !== ownerToken) {
            await rename(releasedPath, lockPath).catch(() => {});
            throw lockError("A replacement lock was moved during release; it was not deleted.", ownershipLostCode, releasedPath, moved.owner);
          }
          try {
            await rm(releasedPath, { recursive: true, force: false });
          } catch {
            // The fixed lock is released. A token-specific tombstone is safer than
            // reporting a committed operation as failed and provoking a retry.
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let observed;
    try {
      observed = await readOwner(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const currentMs = typeof now === "function" ? now() : now;
    const heartbeatMs = Date.parse(observed.owner?.heartbeatAt ?? "");
    const ageMs = Number.isFinite(heartbeatMs) ? currentMs - heartbeatMs : currentMs - observed.info.mtimeMs;
    const alive = observed.owner ? await isOwnerAlive(observed.owner) : null;
    const recoverable = alive === false || (alive !== true && ageMs > staleMs);
    if (!recoverable) {
      throw lockError("Another execution owns this durable lock.", lockedCode, lockPath, observed.owner);
    }

    const orphanIdentity = observed.owner?.ownerToken
      ?? `${observed.info.dev}:${observed.info.ino}:${observed.info.mtimeMs}`;
    const orphanPath = `${lockPath}.orphan-${sha256(orphanIdentity).slice(0, 24)}`;
    try {
      await rename(lockPath, orphanPath);
    } catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) continue;
      throw error;
    }
  }
  throw lockError("Durable lock contention could not be resolved safely.", lockedCode, lockPath);
}

export async function withDurableLock(lockPath, fn, options = {}) {
  const lock = await acquireDurableLock(lockPath, options);
  let result;
  let operationError = null;
  try {
    result = await fn(lock);
  } catch (error) {
    operationError = error;
  }
  try {
    await lock.release();
  } catch (releaseError) {
    if (!operationError) throw releaseError;
  }
  if (operationError) throw operationError;
  return result;
}
