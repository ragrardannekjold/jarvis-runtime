import { sha256Bytes } from "../canonical.mjs";
import { fail } from "../errors.mjs";
import { assertExactKeys } from "../security.mjs";

const RECORD_ID = /^[0-9a-fA-F]{32}$/;
const API_ROOT = "https://public-api.prozorro.gov.ua/api/2.5/tenders";
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_AWARDS = 100;
const MAX_CONTRACTS = 100;
const MAX_SUPPLIERS_PER_AWARD = 20;

function boundedString(value, maxLength, label) {
  if (typeof value !== "string") return null;
  if (value.length > maxLength) {
    fail("SOURCE_PROJECTION_TOO_LARGE", `${label} exceeds projection limit`);
  }
  return value;
}

function boundedArray(value, maxLength, label) {
  if (!Array.isArray(value)) return [];
  if (value.length > maxLength) {
    fail("SOURCE_PROJECTION_TOO_LARGE", `${label} exceeds projection limit`);
  }
  return value;
}

function compactValue(value) {
  if (!value || typeof value !== "object") return null;
  return {
    amount: typeof value.amount === "number" ? value.amount : null,
    currency: boundedString(value.currency, 16, "currency"),
    value_added_tax_included:
      typeof value.valueAddedTaxIncluded === "boolean"
        ? value.valueAddedTaxIncluded
        : null,
  };
}

function compactPeriod(period) {
  if (!period || typeof period !== "object") return null;
  return {
    start_date: boundedString(period.startDate, 64, "period start"),
    end_date: boundedString(period.endDate, 64, "period end"),
  };
}

function compactOrganization(entity) {
  const identifier = entity?.identifier;
  return {
    legal_name: boundedString(entity?.name, 512, "organization name"),
    identifier:
      identifier && typeof identifier === "object"
        ? {
            scheme:
              boundedString(identifier.scheme, 32, "identifier scheme"),
            id: boundedString(identifier.id, 128, "identifier id"),
          }
        : null,
    kind: boundedString(entity?.kind, 64, "organization kind"),
  };
}

export function normalizeTender(data) {
  const awards = boundedArray(data.awards, MAX_AWARDS, "awards");
  const contracts = boundedArray(data.contracts, MAX_CONTRACTS, "contracts");
  return {
    record_id: data.id,
    tender_id: boundedString(data.tenderID, 128, "tender id"),
    status: boundedString(data.status, 64, "tender status"),
    procurement_method_type:
      boundedString(data.procurementMethodType, 128, "procurement method"),
    date_created:
      boundedString(data.dateCreated, 64, "date created"),
    date_modified:
      boundedString(data.dateModified, 64, "date modified"),
    value: compactValue(data.value),
    tender_period: compactPeriod(data.tenderPeriod),
    procuring_entity: compactOrganization(data.procuringEntity),
    counts: {
      awards: Array.isArray(data.awards) ? data.awards.length : 0,
      bids: Array.isArray(data.bids) ? data.bids.length : 0,
      complaints: Array.isArray(data.complaints) ? data.complaints.length : 0,
      contracts: Array.isArray(data.contracts) ? data.contracts.length : 0,
      documents: Array.isArray(data.documents) ? data.documents.length : 0,
      items: Array.isArray(data.items) ? data.items.length : 0,
    },
    award_summaries: awards.map((award) => ({
          id: boundedString(award.id, 128, "award id"),
          status: boundedString(award.status, 64, "award status"),
          date: boundedString(award.date, 64, "award date"),
          value: compactValue(award.value),
          suppliers: boundedArray(
            award.suppliers,
            MAX_SUPPLIERS_PER_AWARD,
            "award suppliers",
          ).map(compactOrganization),
        })),
    contract_summaries: contracts.map((contract) => ({
          id: boundedString(contract.id, 128, "contract id"),
          award_id:
            boundedString(contract.awardID, 128, "contract award id"),
          status: boundedString(contract.status, 64, "contract status"),
          date_signed:
            boundedString(contract.dateSigned, 64, "contract date signed"),
          value: compactValue(contract.value),
        })),
  };
}

async function readBoundedBody(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail("SOURCE_RESPONSE_TOO_LARGE", "Official response exceeds size limit");
  }

  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          fail("SOURCE_RESPONSE_TOO_LARGE", "Official response exceeds size limit");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error?.code === "SOURCE_RESPONSE_TOO_LARGE") throw error;
      fail("SOURCE_UNAVAILABLE", "Official response body could not be read", {
        cause: error?.name ?? "Error",
      });
    }
    return Buffer.concat(chunks, total);
  }

  try {
    const rawBytes = Buffer.from(await response.arrayBuffer());
    if (rawBytes.length > MAX_RESPONSE_BYTES) {
      fail("SOURCE_RESPONSE_TOO_LARGE", "Official response exceeds size limit");
    }
    return rawBytes;
  } catch (error) {
    if (error?.code === "SOURCE_RESPONSE_TOO_LARGE") throw error;
    fail("SOURCE_UNAVAILABLE", "Official response body could not be read", {
      cause: error?.name ?? "Error",
    });
  }
}

export function createCuckooAdapter({
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    fail("FETCH_UNAVAILABLE", "A fetch implementation is required");
  }

  return async function prozorroSnapshot(payload) {
    assertExactKeys(payload, ["record_id"], "INVALID_CUCKOO_PAYLOAD");
    if (typeof payload.record_id !== "string" || !RECORD_ID.test(payload.record_id)) {
      fail("INVALID_RECORD_ID", "record_id must contain exactly 32 hex digits");
    }

    const recordId = payload.record_id.toLowerCase();
    const sourceUrl = `${API_ROOT}/${recordId}`;
    let response;
    try {
      response = await fetchImpl(sourceUrl, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      fail("SOURCE_UNAVAILABLE", "Official Prozorro public API fetch failed", {
        cause: error?.name ?? "Error",
      });
    }

    if (!response?.ok) {
      fail("SOURCE_HTTP_ERROR", "Official Prozorro public API returned an error", {
        status: response?.status ?? null,
      });
    }

    const rawBytes = await readBoundedBody(response);

    let rawText;
    try {
      rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    } catch {
      fail("SOURCE_INVALID_UTF8", "Official response is not valid UTF-8");
    }

    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      fail("SOURCE_INVALID_JSON", "Official response is not valid JSON");
    }
    const data = body?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      fail("SOURCE_SCHEMA_MISMATCH", "Official response has no tender data object");
    }
    if (String(data.id).toLowerCase() !== recordId) {
      fail("SOURCE_ID_MISMATCH", "Official response record id does not match request");
    }

    return {
      schema: "public.prozorro_snapshot.v1",
      candidate_only: true,
      record_id: recordId,
      source: {
        authority: "Prozorro public API",
        family_id: "prozorro_official_public_api",
        url: sourceUrl,
        retrieved_at: now(),
      },
      raw_commitment: {
        sha256: sha256Bytes(rawBytes),
        bytes: rawBytes.length,
        archive_status: "NOT_ARCHIVED_PUBLIC_CANARY",
      },
      normalized: normalizeTender(data),
    };
  };
}
