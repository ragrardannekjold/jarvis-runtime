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
    value.source?.family_id !== "openprocurement_official_api" ||
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
        text: `The official OpenProcurement API returned tender ${normalized.tender_id ?? snapshot.record_id} with status ${normalized.status ?? "unspecified"}.`,
      },
      EVIDENCE: [
        {
          type: "OFFICIAL_API_SNAPSHOT",
          record_id: snapshot.record_id,
          tender_id: normalized.tender_id,
          status: normalized.status,
          procurement_method_type: normalized.procurement_method_type,
          value: normalized.value,
          counts: normalized.counts,
          contract_summaries: normalized.contract_summaries,
          raw_sha256: snapshot.raw_commitment.sha256,
          raw_bytes: snapshot.raw_commitment.bytes,
        },
      ],
      SOURCE_GENEALOGY: [
        {
          family_id: "openprocurement_official_api",
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
          "Direct official API observation with an exact raw-response SHA-256 commitment; no inference of wrongdoing is made.",
      },
      NEXT_FALSIFIER: {
        test:
          "Re-fetch the same official record and compare its identifier, status, contract summaries, and raw SHA-256 commitment.",
        would_falsify:
          "An official response showing a different record identifier, or primary contract documents contradicting the normalized fields.",
      },
      SENSITIVITY: "PUBLIC",
    };
  };
}
