import { sha256Object } from "./canonical.mjs";
import { WorkerError } from "./errors.mjs";
import { EphemeralTaskLedger } from "./ledger.mjs";
import { parseEnvelope, validateEnvelope } from "./security.mjs";

export class PublicTaskDispatcher {
  #registry;
  #ledger;
  #inFlight = new Map();

  constructor({ registry, ledger = new EphemeralTaskLedger() }) {
    this.#registry = registry;
    this.#ledger = ledger;
  }

  async dispatchJson(jsonText) {
    return this.dispatch(parseEnvelope(jsonText));
  }

  async dispatch(input) {
    const envelope = validateEnvelope(input);
    const fingerprint = sha256Object(envelope);
    const claim = this.#ledger.claim(envelope.task_id, fingerprint);

    if (claim.mode === "COMPLETED") return claim.entry.result;
    if (claim.mode === "RUNNING") return this.#inFlight.get(envelope.task_id);
    if (claim.mode !== "NEW") {
      throw new WorkerError(
        "TASK_NOT_RUNNABLE",
        `Task is in non-runnable state ${claim.mode}`,
      );
    }

    const handler = this.#registry.resolve(envelope.worker, envelope.capability);
    const token = claim.entry.token;
    const execution = (async () => {
      try {
        const adapterResult = await handler(envelope.payload, {
          task_id: envelope.task_id,
          case_id: envelope.case_id,
          sensitivity: envelope.sensitivity,
        });
        const result = {
          schema: "public.outsource_result.v1",
          task_id: envelope.task_id,
          case_id: envelope.case_id,
          worker: envelope.worker,
          capability: envelope.capability,
          sensitivity: "PUBLIC",
          input_sha256: fingerprint,
          candidate_only: true,
          result: adapterResult,
        };
        return this.#ledger.commit(envelope.task_id, token, result);
      } catch (error) {
        this.#ledger.fail(
          envelope.task_id,
          token,
          error instanceof WorkerError ? error.code : "ADAPTER_FAILED",
        );
        throw error;
      }
    })();

    this.#inFlight.set(envelope.task_id, execution);
    try {
      return await execution;
    } finally {
      if (this.#inFlight.get(envelope.task_id) === execution) {
        this.#inFlight.delete(envelope.task_id);
      }
    }
  }

  revokeTask(taskId) {
    return this.#ledger.revoke(taskId);
  }

  inspectTask(taskId) {
    return this.#ledger.inspect(taskId);
  }
}
