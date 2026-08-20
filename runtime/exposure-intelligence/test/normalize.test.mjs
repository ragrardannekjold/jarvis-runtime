import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecords } from "../src/normalize.mjs";

const context = {
  queryHash: "q".repeat(64),
  fetchedAt: "2026-08-16T12:00:00.000Z",
  rawHash: "r".repeat(64),
};

test("current Censys v3 service.cert and service.scan_time fields normalize", () => {
  const [observation] = normalizeRecords({
    ...context,
    provider: "censys",
    asset: { type: "cidr", value: "192.0.2.0/24" },
    records: [{
      host: { ip: "192.0.2.8" },
      matched_services: [{ service: {
        port: 443,
        transport_protocol: "TCP",
        protocol: "HTTPS",
        scan_time: "2026-08-15T09:08:07Z",
        cert: {
          fingerprint_sha256: "c".repeat(64),
          subject_dn: "CN=example.com",
          issuer_dn: "CN=Test CA",
          names: ["example.com"],
        },
      } }],
    }],
  });
  assert.equal(observation.observedAt, "2026-08-15T09:08:07Z");
  assert.equal(observation.service.port, 443);
  assert.equal(observation.certificate.fingerprintSha256, "c".repeat(64));
  assert.equal(observation.certificate.subject, "CN=example.com");
});

test("Netlas prefers the secure protocol field over generic prot7", () => {
  const [observation] = normalizeRecords({
    ...context,
    provider: "netlas",
    asset: { type: "domain", value: "example.com" },
    records: [{ host: "example.com", protocol: "https", prot7: "http", port: 443 }],
  });
  assert.equal(observation.service.protocol, "https");
});
