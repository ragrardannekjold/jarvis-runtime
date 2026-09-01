import { randomUUID } from "node:crypto";
import { clone } from "./canonical.mjs";
import { fail } from "./errors.mjs";

// Process-local canary ledger. Durable idempotency for the GitHub integration
// comes from immutable terminal issue comments, not from this ephemeral map.
export class EphemeralTaskLedger {
  #tasks = new Map();

  inspect(taskId) {
    const value = this.#tasks.get(taskId);
    return value ? clone(value) : undefined;
  }

  claim(taskId, fingerprint) {
    const existing = this.#tasks.get(taskId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        fail(
          "TASK_ID_CONFLICT",
          "task_id is already bound to a different immutable envelope",
        );
      }
      return { mode: existing.state, entry: clone(existing) };
    }

    const entry = {
      task_id: taskId,
      fingerprint,
      token: randomUUID(),
      state: "RUNNING",
    };
    this.#tasks.set(taskId, entry);
    return { mode: "NEW", entry: clone(entry) };
  }

  commit(taskId, token, result) {
    const current = this.#tasks.get(taskId);
    if (!current || current.state !== "RUNNING" || current.token !== token) {
      fail("STALE_RESULT", "Result token is no longer current for task_id");
    }
    const completed = { ...current, state: "COMPLETED", result: clone(result) };
    this.#tasks.set(taskId, completed);
    return clone(completed.result);
  }

  fail(taskId, token, errorCode) {
    const current = this.#tasks.get(taskId);
    if (current?.state === "RUNNING" && current.token === token) {
      this.#tasks.set(taskId, {
        ...current,
        state: "FAILED",
        error_code: errorCode ?? "ADAPTER_FAILED",
      });
    }
  }

  revoke(taskId) {
    const current = this.#tasks.get(taskId);
    if (!current) return false;
    this.#tasks.set(taskId, {
      ...current,
      token: randomUUID(),
      state: "REVOKED",
    });
    return true;
  }
}
