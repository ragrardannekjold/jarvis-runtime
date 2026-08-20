import { canonicalizeDomain, ipInCidr } from "./assets.mjs";
import { asArray, sha256, stableStringify } from "./util.mjs";

function exactDomain(value, expected) {
  if (typeof value !== "string") return false;
  try {
    return canonicalizeDomain(value) === expected;
  } catch {
    return false;
  }
}

function exactCertificateSubject(value, expected) {
  if (typeof value !== "string") return null;
  if (exactDomain(value, expected)) return expected;
  const match = /^CN\s*=\s*([^,]+)$/i.exec(value.trim());
  return match && exactDomain(match[1], expected) ? `CN=${expected}` : null;
}

export function observationBelongsToAsset(observation, asset) {
  if (asset.type === "cidr") {
    return ipInCidr(observation?.address?.ip, asset.value);
  }
  const candidates = [
    observation?.address?.domain,
    ...asArray(observation?.dns?.names),
  ];
  return candidates.some((candidate) => exactDomain(candidate, asset.value));
}

function sanitizeDomainObservation(observation, asset) {
  const exactNames = (values) => (
    asArray(values).some((value) => exactDomain(value, asset.value)) ? [asset.value] : []
  );
  const sanitized = {
    ...observation,
    address: {
      ...observation.address,
      domain: exactDomain(observation?.address?.domain, asset.value) ? asset.value : null,
    },
    dns: {
      names: exactNames(observation?.dns?.names),
      reverseNames: exactNames(observation?.dns?.reverseNames),
    },
    certificate: {
      ...observation.certificate,
      names: exactNames(observation?.certificate?.names),
      subject: exactCertificateSubject(observation?.certificate?.subject, asset.value),
    },
  };
  const { observationId: _oldId, fetchedAt: _fetchedAt, evidence: _evidence, ...core } = sanitized;
  return { ...sanitized, observationId: sha256(stableStringify(core)) };
}

export function enforceObservationScope(observations, asset) {
  const accepted = [];
  let dropped = 0;
  for (const observation of observations) {
    if (observationBelongsToAsset(observation, asset)) {
      accepted.push(asset.type === "domain" ? sanitizeDomainObservation(observation, asset) : observation);
    }
    else dropped += 1;
  }
  return { accepted, dropped };
}
