import { asArray, firstString, sha256, stableStringify, uniqueStrings } from "./util.mjs";

function normalizeSoftware(value) {
  const entries = asArray(value).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const direct = {
      product: firstString(item.product, item.name, item.vendor_product),
      vendor: firstString(item.vendor),
      version: firstString(item.version),
    };
    const tags = asArray(item.tag).map((tag) => ({
      product: firstString(tag?.fullname, tag?.name),
      vendor: null,
      version: firstString(tag?.version),
    }));
    return [direct, ...tags];
  }).filter((item) => item.product || item.vendor || item.version);
  const unique = new Map(entries.map((item) => [stableStringify(item), item]));
  return [...unique.values()].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function normalizeCertificate(raw) {
  const cert = raw?.leaf_data ?? raw?.leaf ?? raw;
  if (!cert || typeof cert !== "object") {
    return { fingerprintSha256: null, subject: null, issuer: null, names: [], validFrom: null, validTo: null };
  }
  const parsed = cert.parsed ?? cert;
  const validity = parsed.validity_period ?? parsed.validity ?? cert.validity ?? {};
  const names = uniqueStrings([
    parsed.names,
    cert.names,
    parsed.extensions?.subject_alt_name?.dns_names,
    parsed.extensions?.subject_alt_name?.dns,
    cert.extensions?.subject_alt_name?.dns_names,
  ]);
  return {
    fingerprintSha256: firstString(cert.fingerprint_sha256, cert.sha256, cert.fingerprint, parsed.fingerprint_sha256),
    subject: firstString(parsed.subject_dn, cert.subject_dn, parsed.subject?.common_name, parsed.subject?.organization),
    issuer: firstString(parsed.issuer_dn, cert.issuer_dn, parsed.issuer?.common_name, parsed.issuer?.organization),
    names,
    validFrom: firstString(validity.not_before, validity.start, validity.valid_from),
    validTo: firstString(validity.not_after, validity.end, validity.valid_to),
  };
}

function pickCertificate(service, record) {
  return service?.cert
    ?? service?.tls?.certificates?.leaf_data
    ?? service?.tls?.certificates?.leaf
    ?? service?.tls?.certificate
    ?? service?.certificate
    ?? asArray(service?.certificates)[0]
    ?? record?.certificate
    ?? null;
}

function makeObservation({ provider, queryHash, asset, fetchedAt, rawHash, recordIndex, address, service, certificate, dns, observedAt }) {
  const core = {
    schemaVersion: 1,
    provider,
    queryHash,
    asset,
    observedAt: observedAt ?? fetchedAt,
    address: {
      ip: address.ip ?? null,
      domain: address.domain ?? null,
    },
    service: {
      port: Number.isInteger(service.port) ? service.port : null,
      transport: service.transport ?? null,
      protocol: service.protocol ?? null,
      software: service.software ?? [],
    },
    certificate,
    dns: {
      names: dns.names ?? [],
      reverseNames: dns.reverseNames ?? [],
    },
  };
  return {
    ...core,
    observationId: sha256(stableStringify(core)),
    fetchedAt,
    evidence: { rawHash, recordIndex },
  };
}

function normalizeCensys(records, context) {
  return records.flatMap((record, recordIndex) => {
    const host = record?.host ?? record?.resource ?? record ?? {};
    const services = asArray(
      record?.matched_services?.length
        ? record.matched_services
        : host.services ?? record?.service,
    );
    const dns = {
      names: uniqueStrings([host.dns?.names, host.names, record?.dns?.names]),
      reverseNames: uniqueStrings([
        host.dns?.reverse_dns?.names,
        host.reverse_dns?.names,
        host.ptr,
        record?.ptr,
      ]),
    };
    const address = { ip: firstString(host.ip, record?.ip), domain: null };
    const list = services.length ? services : [null];
    return list.map((serviceWrapper) => {
      const service = serviceWrapper?.service ?? serviceWrapper;
      return makeObservation({
      ...context,
      recordIndex,
      address,
      observedAt: firstString(
        service?.scan_time,
        service?.observed_at,
        service?.last_observed_at,
        host.last_updated_at,
        host.observed_at,
        record?.observed_at,
      ),
      service: {
        port: Number.isInteger(service?.port) ? service.port : null,
        transport: firstString(service?.transport_protocol, service?.transport),
        protocol: firstString(service?.protocol, service?.service_name, service?.extended_service_name),
        software: normalizeSoftware(service?.software),
      },
      certificate: normalizeCertificate(pickCertificate(service, record)),
      dns,
      });
    });
  });
}

function normalizeNetlas(records, context) {
  return records.map((record, recordIndex) => {
    const host = firstString(record?.host);
    const hostIsDomain = host && !/^\[?[0-9a-f:.]+\]?$/i.test(host);
    return makeObservation({
      ...context,
      recordIndex,
      address: {
        ip: firstString(record?.ip, hostIsDomain ? null : host),
        domain: firstString(hostIsDomain ? host : null, record?.domain),
      },
      observedAt: firstString(record?.last_updated, record?.["@timestamp"], record?.observed_at),
      service: {
        port: Number.isInteger(record?.port) ? record.port : Number.isInteger(Number(record?.port)) ? Number(record.port) : null,
        transport: firstString(record?.prot4, record?.transport_protocol, record?.transport),
        protocol: firstString(record?.protocol, record?.prot7),
        software: normalizeSoftware(record?.software),
      },
      certificate: normalizeCertificate(record?.certificate),
      dns: {
        names: uniqueStrings([record?.domain, hostIsDomain ? host : null, record?.dns?.names]),
        reverseNames: uniqueStrings([record?.ptr, record?.reverse_dns]),
      },
    });
  });
}

function normalizeShodan(records, context) {
  return records.map((record, recordIndex) => makeObservation({
    ...context,
    recordIndex,
    address: { ip: firstString(record?.ip_str), domain: null },
    observedAt: firstString(record?.timestamp, record?.last_update),
    service: {
      port: Number.isInteger(record?.port) ? record.port : null,
      transport: firstString(record?.transport),
      protocol: firstString(record?._shodan?.module, record?.product),
      software: normalizeSoftware([{
        product: firstString(record?.product),
        vendor: firstString(record?.cpe23?.[0], record?.cpe?.[0]),
        version: firstString(record?.version),
      }]),
    },
    certificate: normalizeCertificate(record?.ssl?.cert),
    dns: { names: uniqueStrings([record?.hostnames, record?.domains]), reverseNames: [] },
  }));
}

export function normalizeRecords({ provider, records, queryHash, asset, fetchedAt, rawHash }) {
  const context = { provider, queryHash, asset, fetchedAt, rawHash };
  const observations = provider === "shodan"
    ? normalizeShodan(records, context)
    : provider === "censys"
      ? normalizeCensys(records, context)
      : normalizeNetlas(records, context);
  const unique = new Map(observations.map((observation) => [observation.observationId, observation]));
  return [...unique.values()].sort((a, b) => a.observationId.localeCompare(b.observationId));
}
