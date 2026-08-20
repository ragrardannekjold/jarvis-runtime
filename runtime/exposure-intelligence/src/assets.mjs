import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { lstat, readFile } from "node:fs/promises";
import { ExposureError, invariant } from "./errors.mjs";

function ipv4ToBigInt(ip) {
  return ip.split(".").reduce((total, octet) => (total << 8n) | BigInt(Number(octet)), 0n);
}

function bigintToIpv4(value) {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
}

function expandIpv6(ip) {
  const input = ip.toLowerCase();
  invariant(!input.includes("%"), "IPv6 zone identifiers are not allowed.", "INVALID_CIDR");
  const occurrences = input.split("::").length - 1;
  invariant(occurrences <= 1, "Invalid IPv6 address.", "INVALID_CIDR");
  const [leftRaw, rightRaw = ""] = input.split("::");
  const convert = (side) => {
    if (!side) return [];
    const parts = side.split(":");
    const last = parts.at(-1);
    if (last?.includes(".")) {
      invariant(isIP(last) === 4, "Invalid embedded IPv4 address.", "INVALID_CIDR");
      const v4 = ipv4ToBigInt(last);
      parts.splice(-1, 1, ((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
    }
    return parts;
  };
  const left = convert(leftRaw);
  const right = convert(rightRaw);
  const missing = 8 - left.length - right.length;
  invariant(occurrences === 1 ? missing >= 1 : missing === 0, "Invalid IPv6 address.", "INVALID_CIDR");
  return [...left, ...Array(missing).fill("0"), ...right].map((part) => {
    invariant(/^[0-9a-f]{1,4}$/.test(part), "Invalid IPv6 address.", "INVALID_CIDR");
    return Number.parseInt(part, 16);
  });
}

function ipv6ToBigInt(ip) {
  return expandIpv6(ip).reduce((total, group) => (total << 16n) | BigInt(group), 0n);
}

function bigintToIpv6(value) {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return groups.map((group) => group.toString(16)).join(":");
  const left = groups.slice(0, bestStart).map((group) => group.toString(16)).join(":");
  const right = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(":");
  return `${left}::${right}`;
}

export function canonicalizeCidr(raw) {
  invariant(typeof raw === "string" && raw.trim() === raw, "CIDR must be a trimmed string.", "INVALID_CIDR");
  const parts = raw.split("/");
  invariant(parts.length === 2, "CIDR notation is required (for example 192.0.2.0/24).", "INVALID_CIDR");
  const [ip, prefixRaw] = parts;
  const family = isIP(ip);
  invariant(family === 4 || family === 6, "Invalid CIDR IP address.", "INVALID_CIDR");
  invariant(/^\d+$/.test(prefixRaw), "Invalid CIDR prefix.", "INVALID_CIDR");
  const prefix = Number(prefixRaw);
  const bits = family === 4 ? 32 : 128;
  invariant(prefix >= 0 && prefix <= bits, `CIDR prefix must be between 0 and ${bits}.`, "INVALID_CIDR");
  const value = family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  const hostBits = BigInt(bits - prefix);
  const network = hostBits === 0n ? value : (value >> hostBits) << hostBits;
  const normalized = family === 4 ? bigintToIpv4(network) : bigintToIpv6(network);
  return `${normalized}/${prefix}`;
}

export function ipInCidr(ip, cidr) {
  const family = isIP(ip);
  if (family !== 4 && family !== 6) return false;
  let normalizedCidr;
  try {
    normalizedCidr = canonicalizeCidr(cidr);
  } catch {
    return false;
  }
  const [networkIp, prefixRaw] = normalizedCidr.split("/");
  if (isIP(networkIp) !== family) return false;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(prefixRaw);
  const hostBits = BigInt(bits - prefix);
  const value = family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  const network = family === 4 ? ipv4ToBigInt(networkIp) : ipv6ToBigInt(networkIp);
  return hostBits === 0n ? value === network : ((value >> hostBits) << hostBits) === network;
}

export function canonicalizeDomain(raw) {
  invariant(typeof raw === "string" && raw.trim() === raw, "Domain must be a trimmed string.", "INVALID_DOMAIN");
  invariant(!raw.includes("*") && !raw.includes("/") && !raw.includes(":") && !raw.includes("@"), "Only an exact domain is allowed; wildcards, URLs, and credentials are forbidden.", "INVALID_DOMAIN");
  const withoutDot = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  const ascii = domainToASCII(withoutDot.toLowerCase());
  invariant(ascii && ascii.length <= 253 && isIP(ascii) === 0, "Invalid domain.", "INVALID_DOMAIN");
  const labels = ascii.split(".");
  invariant(labels.length >= 2 && labels.every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)), "Invalid domain labels.", "INVALID_DOMAIN");
  return ascii;
}

export function parseAsset(raw) {
  invariant(typeof raw === "string" && raw.length > 0, "An asset is required.", "ASSET_REQUIRED");
  if (raw.includes("://")) {
    throw new ExposureError("URLs are forbidden; authorize only an exact domain or CIDR.", { code: "INVALID_DOMAIN" });
  }
  if (raw.includes("/")) return { type: "cidr", value: canonicalizeCidr(raw) };
  if (isIP(raw)) {
    throw new ExposureError("Bare IPs are forbidden. Authorize an exact /32 or /128 CIDR instead.", { code: "CIDR_REQUIRED" });
  }
  return { type: "domain", value: canonicalizeDomain(raw) };
}

export async function loadAllowlist(filePath) {
  invariant(typeof filePath === "string" && filePath, "--allowlist is required.", "ALLOWLIST_REQUIRED");
  const info = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") throw new ExposureError("Allowlist file does not exist.", { code: "ALLOWLIST_NOT_FOUND" });
    throw error;
  });
  invariant(info.isFile() && !info.isSymbolicLink(), "Allowlist must be a regular, non-symlink JSON file.", "INVALID_ALLOWLIST");
  let document;
  try {
    document = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new ExposureError("Allowlist must contain valid JSON.", { code: "INVALID_ALLOWLIST", cause: error });
  }
  invariant(document?.schemaVersion === 1, "Allowlist schemaVersion must be 1.", "INVALID_ALLOWLIST");
  invariant(document?.authorization === "owned_or_explicitly_authorized", "Allowlist must assert owned_or_explicitly_authorized.", "AUTHORIZATION_ASSERTION_REQUIRED");
  invariant(Array.isArray(document.assets) && document.assets.length > 0, "Allowlist assets must be a non-empty array.", "INVALID_ALLOWLIST");
  const assets = document.assets.map((entry) => {
    invariant(entry && (entry.type === "domain" || entry.type === "cidr") && typeof entry.value === "string", "Each allowlist entry needs type and value.", "INVALID_ALLOWLIST");
    const parsed = parseAsset(entry.value);
    invariant(parsed.type === entry.type, "Allowlist type does not match value.", "INVALID_ALLOWLIST");
    return parsed;
  });
  const keys = assets.map((asset) => `${asset.type}:${asset.value}`);
  invariant(new Set(keys).size === keys.length, "Allowlist contains duplicate assets.", "INVALID_ALLOWLIST");
  return { schemaVersion: 1, authorization: document.authorization, assets };
}

export async function authorizeAsset(rawAsset, allowlistPath) {
  const asset = parseAsset(rawAsset);
  const allowlist = await loadAllowlist(allowlistPath);
  const key = `${asset.type}:${asset.value}`;
  invariant(allowlist.assets.some((entry) => `${entry.type}:${entry.value}` === key), "Asset is not an exact entry in the owned/authorized allowlist.", "ASSET_NOT_AUTHORIZED", { asset });
  return asset;
}
