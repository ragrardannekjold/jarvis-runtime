import { sha256Object } from "../canonical.mjs";
import { fail } from "../errors.mjs";
import { assertExactKeys } from "../security.mjs";

function assertCuckooResult(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== "public.prozorro_snapshot.v1" ||
    value.candidate_only !== true ||
    !/^[0-9a-f]{32}$/.test(value.record_id ?? "") ||
    !/^[0-9a-f]{64}$/.test(value.raw_commitment?.sha256 ?? "") ||
    value.raw_commitment?.archive_status !== "NOT_ARCHIVED_PUBLIC_CANARY" ||
    value.source?.family_id !== "prozorro_official_public_api" ||
    value.normalized?.record_id !== value.record_id
  ) {
    fail("INVALID_CUCKOO_RESULT", "Payload is not a valid Cuckoo public snapshot");
  }
}

export function createBuboAdapter() {
  return async function evidencePacket(payload) {
    assertExactKeys(payload, ["cuckoo_result"], "INVALID_BUBO_PAYLOAD");
    assertCuckooResult(payload.cuckoo_result);

    const snapshot = payload.cuckoo_result;
    const normalized = snapshot.normalized;
    const packetId = sha256Object(snapshot);

    return {
      schema: "public.evidence_packet.v1",
      packet_id: packetId,
      candidate_only: true,
      canonical_admission: "PENDING_VERIFIER",
      CLAIM: {
        type: "OBSERVATION",
        text: `The official Prozorro public API returned tender ${normalized.tender_id ?? snapshot.record_id} by ${normalized.procuring_entity?.legal_name ?? "an unspecified buyer"} with status ${normalized.status ?? "unspecified"}.`,
      },
      EVIDENCE: [
        {
          type: "OFFICIAL_API_SNAPSHOT",
          record_id: snapshot.record_id,
          tender_id: normalized.tender_id,
          status: normalized.status,
          procurement_method_type: normalized.procurement_method_type,
          procuring_entity: normalized.procuring_entity,
          value: normalized.value,
          counts: normalized.counts,
          award_summaries: normalized.award_summaries,
          contract_summaries: normalized.contract_summaries,
          raw_sha256: snapshot.raw_commitment.sha256,
          raw_bytes: snapshot.raw_commitment.bytes,
          raw_archive_status: snapshot.raw_commitment.archive_status,
        },
      ],
      SOURCE_GENEALOGY: [
        {
          family_id: "prozorro_official_public_api",
          authority: snapshot.source.authority,
          url: snapshot.source.url,
          retrieved_at: snapshot.source.retrieved_at,
          independence_group: "openprocurement_primary_record",
        },
      ],
      CONTRADICTIONS: [],
      CONFIDENCE: {
        level: "HIGH_FOR_SNAPSHOT_EXISTENCE",
        basis:
          "Direct official API observation with a SHA-256 commitment over the exact received HTTP body bytes. The body is not archived in this public canary, and no inference of wrongdoing is made.",
      },
      NEXT_FALSIFIER: {
        test:
          "A verifier should re-fetch and archive the exact source body in an approved evidence store. If its SHA-256 matches, recompute the normalized projection; if it differs, preserve it as a new source version.",
        would_falsify:
          "A body matching the committed SHA-256 that yields different normalized fields, or an official response whose record identifier does not match the request.",
      },
      SENSITIVITY: "PUBLIC",
    };
  };
}
