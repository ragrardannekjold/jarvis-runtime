import { fail } from "./errors.mjs";

export class CapabilityRegistry {
  #handlers = new Map();

  register(worker, capability, handler) {
    if (typeof handler !== "function") {
      fail("INVALID_HANDLER", "Capability handler must be a function");
    }
    const key = this.#key(worker, capability);
    if (this.#handlers.has(key)) {
      fail("DUPLICATE_CAPABILITY", `Capability already registered: ${key}`);
    }
    this.#handlers.set(key, handler);
    return this;
  }

  resolve(worker, capability) {
    const key = this.#key(worker, capability);
    const handler = this.#handlers.get(key);
    if (!handler) {
      fail(
        "CAPABILITY_MISMATCH",
        `No adapter registered for worker=${worker} capability=${capability}`,
      );
    }
    return handler;
  }

  list() {
    return [...this.#handlers.keys()].sort();
  }

  #key(worker, capability) {
    return `${worker}:${capability}`;
  }
}
