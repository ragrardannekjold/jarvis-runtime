import { createHash } from "node:crypto";

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Object(value) {
  return sha256Text(stableStringify(value));
}

export function clone(value) {
  return structuredClone(value);
}
