import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function tempWorkspace() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "exposure-intel-test-"));
  const allowlistPath = path.join(baseDir, "allowlist.json");
  await writeFile(allowlistPath, JSON.stringify({
    schemaVersion: 1,
    authorization: "owned_or_explicitly_authorized",
    assets: [
      { type: "domain", value: "example.com" },
      { type: "domain", value: "app.example.com" },
      { type: "cidr", value: "192.0.2.0/24" },
      { type: "cidr", value: "2001:db8::/64" },
    ],
  }), { mode: 0o600 });
  return { baseDir, allowlistPath };
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export const fixedNow = () => Date.parse("2026-08-16T12:00:00.000Z");

export function censysHit(ip, { port = 443, observedAt = "2026-08-15T10:00:00Z" } = {}) {
  return {
    host: {
      ip,
      dns: {
        names: ["app.example.com"],
        reverse_dns: { names: ["ptr.example.com"] },
      },
      services: [{
        port,
        transport_protocol: "TCP",
        protocol: "HTTPS",
        observed_at: observedAt,
        software: [{ product: "nginx", version: "1.27" }],
        tls: {
          certificates: {
            leaf_data: {
              fingerprint_sha256: "a".repeat(64),
              parsed: {
                subject_dn: "CN=app.example.com",
                issuer_dn: "CN=Example CA",
                names: ["app.example.com"],
                validity_period: {
                  not_before: "2026-01-01T00:00:00Z",
                  not_after: "2027-01-01T00:00:00Z"
                }
              }
            }
          }
        }
      }]
    }
  };
}

export function netlasRecord(index = 1) {
  return {
    data: {
      ip: `192.0.2.${index}`,
      host: "example.com",
      domain: ["example.com"],
      ptr: [`ptr-${index}.example.com`],
      port: 443,
      prot4: "tcp",
      prot7: "https",
      last_updated: "2026-08-15T11:00:00Z",
      certificate: {
        fingerprint_sha256: "b".repeat(64),
        subject_dn: "CN=example.com",
        issuer_dn: "CN=Example CA",
        names: ["example.com"],
        validity: { start: "2026-01-01T00:00:00Z", end: "2027-01-01T00:00:00Z" }
      }
    }
  };
}
