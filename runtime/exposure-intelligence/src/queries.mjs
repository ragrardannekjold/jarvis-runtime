import { sha256, stableStringify } from "./util.mjs";

const CENSYS_ENDPOINT = "https://api.platform.censys.io/v3/global/search/query";
const NETLAS_ENDPOINT = "https://app.netlas.io/api/responses/";
const SHODAN_ENDPOINT = "https://api.shodan.io/shodan/host/search";

export function buildShodanPlan(asset) {
  const query = asset.type === "cidr"
    ? `net:\"${asset.value}\"`
    : `hostname:\"${asset.value}\"`;
  const template = {
    provider: "shodan",
    method: "GET",
    endpoint: SHODAN_ENDPOINT,
    query,
    pageSize: 100,
    queryCreditsPerPage: 1,
  };
  return { ...template, queryHash: sha256(stableStringify(template)) };
}

export function buildCensysPlan(asset, pageSize = 100) {
  const query = asset.type === "cidr"
    ? `host.ip: \"${asset.value}\"`
    : `host.dns.names: \"${asset.value}\"`;
  const template = {
    provider: "censys",
    method: "POST",
    endpoint: CENSYS_ENDPOINT,
    query,
    pageSize,
  };
  return { ...template, queryHash: sha256(stableStringify(template)) };
}

export function buildNetlasPlan(asset) {
  const query = asset.type === "cidr"
    ? `ip:\"${asset.value}\"`
    : `host:${asset.value}`;
  const template = {
    provider: "netlas",
    method: "GET",
    endpoint: NETLAS_ENDPOINT,
    query,
    pageSize: 20,
    fields: "ip,host,domain,ptr,port,protocol,prot4,prot7,last_updated,@timestamp,certificate,uri",
  };
  return { ...template, queryHash: sha256(stableStringify(template)) };
}

export function buildPlan(provider, asset, pageSize) {
  if (provider === "shodan") return buildShodanPlan(asset);
  if (provider === "censys") return buildCensysPlan(asset, pageSize);
  if (provider === "netlas") return buildNetlasPlan(asset);
  throw new Error(`Unknown provider: ${provider}`);
}
