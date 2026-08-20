import test from "node:test";
import assert from "node:assert/strict";
import { enforceObservationScope, observationBelongsToAsset } from "../src/scope.mjs";

function observation({ ip = null, domain = null, dns = [], reverseNames = [], certNames = [], subject = null } = {}) {
  return {
    address: { ip, domain },
    dns: { names: dns, reverseNames },
    certificate: { names: certNames, subject, issuer: "CN=Provenance CA" },
  };
}

test("CIDR post-filter accepts only IPs inside the exact authorized network", () => {
  const asset = { type: "cidr", value: "192.0.2.0/24" };
  const result = enforceObservationScope([
    observation({ ip: "192.0.2.10" }),
    observation({ ip: "198.51.100.10" }),
    observation({ domain: "example.com" }),
  ], asset);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].address.ip, "192.0.2.10");
  assert.equal(result.dropped, 2);
});

test("domain policy is exact: subdomains and wildcard certificates are not implicitly authorized", () => {
  const asset = { type: "domain", value: "example.com" };
  assert.equal(observationBelongsToAsset(observation({ domain: "example.com" }), asset), true);
  assert.equal(observationBelongsToAsset(observation({ dns: ["EXAMPLE.com."] }), asset), true);
  assert.equal(observationBelongsToAsset(observation({ certNames: ["example.com"] }), asset), false);
  assert.equal(observationBelongsToAsset(observation({ domain: "app.example.com" }), asset), false);
  assert.equal(observationBelongsToAsset(observation({ dns: ["app.example.com"] }), asset), false);
  assert.equal(observationBelongsToAsset(observation({ certNames: ["*.example.com"] }), asset), false);
});

test("accepted exact-domain observations remove unrelated DNS and certificate identity fields", () => {
  const asset = { type: "domain", value: "example.com" };
  const result = enforceObservationScope([observation({
    domain: "EXAMPLE.com.",
    dns: ["example.com", "unrelated.invalid"],
    reverseNames: ["ptr.unrelated.invalid"],
    certNames: ["example.com", "unrelated.invalid"],
    subject: "CN=unrelated.invalid",
  })], asset);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.accepted[0].dns.names, ["example.com"]);
  assert.deepEqual(result.accepted[0].dns.reverseNames, []);
  assert.deepEqual(result.accepted[0].certificate.names, ["example.com"]);
  assert.equal(result.accepted[0].certificate.subject, null);
  assert.equal(result.accepted[0].certificate.issuer, "CN=Provenance CA");
});
