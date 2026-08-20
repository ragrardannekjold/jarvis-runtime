import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const SECRET_KEY = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|set-cookie)/i;
const BEARER_VALUE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : typeof value === "string" || ArrayBuffer.isView(value)
      ? value
      : stableStringify(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export function redact(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(BEARER_VALUE, "Bearer [REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export function isoNow(now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  return new Date(value).toISOString();
}

export function parseRetryAfter(headers, now = Date.now) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  if (/^\d+$/.test(raw.trim())) return Math.min(Number(raw.trim()) * 1000, 3_600_000);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  const current = typeof now === "function" ? now() : now;
  return Math.max(0, Math.min(at - current, 3_600_000));
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function atomicWriteJson(filePath, value, mode = 0o600) {
  await atomicWriteFile(filePath, `${stableStringify(value)}\n`, mode);
}

export async function atomicWriteFile(filePath, value, mode = 0o600) {
  const parentDir = path.dirname(filePath);
  await ensurePrivateDir(parentDir);
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let renamed = false;
  try {
    handle = await open(temp, "wx", mode);
    await handle.chmod(mode);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, filePath);
    renamed = true;
    await chmod(filePath, mode);
    await fsyncDirectory(parentDir);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function fsyncDirectory(dirPath) {
  const directory = await open(dirPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function ensurePrivateDir(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  await chmod(dirPath, 0o700);
}

export async function assertRegularFile(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw Object.assign(new Error("Expected a regular file."), { code: "NOT_REGULAR_FILE" });
}

export function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function uniqueStrings(values) {
  return [...new Set(values.flatMap(asArray).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort();
}
