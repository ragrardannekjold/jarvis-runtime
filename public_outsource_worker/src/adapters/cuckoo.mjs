import { sha256Text } from "../canonical.mjs";
import { fail } from "../errors.mjs";
import { assertExactKeys } from "../security.mjs";

const RECORD_ID = /^[0-9a-fA-F]{32}$/;
const API_ROOT = "https://public.api.openprocurement.org/api/2.5/tenders";
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function compactValue(value) {
  if (!value || typeof value !== "object") return null;
  return {
    amount: typeof value.amount === "number" ? value.amount : null,
    currency: typeof value.currency === "string" ? value.currency : null,
    value_added_tax_included:
      typeof value.valueAddedTaxIncluded === "boolean"
        ? value.valueAddedTaxIncluded
        : null,
  };
}

function compactPeriod(period) {
  if (!period || typeof period !== "object") return null;
  return {
    start_date: typeof period.startDate === "string" ? period.startDate : null,
    end_date: typeof period.endDate === "string" ? period.endDate : null,
  };
}

function compactOrganization(entity) {
  const identifier = entity?.identifier;
  return {
    identifier:
      identifier && typeof identifier === "object"
        ? {
            scheme:
              typeof identifier.scheme === "string" ? identifier.scheme : null,
            id: typeof identifier.id === "string" ? identifier.id : null,
          }
        : null,
    kind: typeof entity?.kind === "string" ? entity.kind : null,
  };
}

export function normalizeTender(data) {
  return {
    record_id: data.id,
    tender_id: typeof data.tenderID === "string" ? data.tenderID : null,
    status: typeof data.status === "string" ? data.status : null,
    procurement_method_type:
      typeof data.procurementMethodType === "string"
        ? data.procurementMethodType
        : null,
    date_created: typeof data.date === "string" ? data.date : null,
    date_modified:
      typeof data.dateModified === "string" ? data.dateModified : null,
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
    contract_summaries: Array.isArray(data.contracts)
      ? data.contracts.map((contract) => ({
          id: typeof contract.id === "string" ? contract.id : null,
          award_id:
            typeof contract.awardID === "string" ? contract.awardID : null,
          status: typeof contract.status === "string" ? contract.status : null,
          date_signed:
            typeof contract.dateSigned === "string" ? contract.dateSigned : null,
          value: compactValue(contract.value),
        }))
      : [],
  };
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
      fail("SOURCE_UNAVAILABLE", "Official OpenProcurement API fetch failed", {
        cause: error?.name ?? "Error",
      });
    }

    if (!response?.ok) {
      fail("SOURCE_HTTP_ERROR", "Official OpenProcurement API returned an error", {
        status: response?.status ?? null,
      });
    }

    const rawText = await response.text();
    if (Buffer.byteLength(rawText, "utf8") > MAX_RESPONSE_BYTES) {
      fail("SOURCE_RESPONSE_TOO_LARGE", "Official response exceeds size limit");
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
        authority: "OpenProcurement public API",
        family_id: "openprocurement_official_api",
        url: sourceUrl,
        retrieved_at: now(),
      },
      raw_commitment: {
        sha256: sha256Text(rawText),
        bytes: Buffer.byteLength(rawText, "utf8"),
      },
      normalized: normalizeTender(data),
    };
  };
}
