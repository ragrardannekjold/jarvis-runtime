import { createBuboAdapter } from "./adapters/bubo.mjs";
import { createCuckooAdapter } from "./adapters/cuckoo.mjs";
import { PublicTaskDispatcher } from "./dispatcher.mjs";
import { CapabilityRegistry } from "./registry.mjs";

export function createPublicRuntime(options = {}) {
  const registry = new CapabilityRegistry()
    .register(
      "cuckoo",
      "prozorro_snapshot_v1",
      createCuckooAdapter({ fetchImpl: options.fetchImpl, now: options.now }),
    )
    .register("bubo", "evidence_packet_v1", createBuboAdapter());

  return {
    registry,
    dispatcher: new PublicTaskDispatcher({ registry, ledger: options.ledger }),
  };
}
