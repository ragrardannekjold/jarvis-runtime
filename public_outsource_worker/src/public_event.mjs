import { fail } from "./errors.mjs";
import { assertExactKeys } from "./security.mjs";

export const EVENT_TYPE = "outsource.task.ready.v1";

export function repositoryDispatchToEnvelope(event) {
  assertExactKeys(event, ["client_payload", "event_type"], "INVALID_EVENT");
  if (event.event_type !== EVENT_TYPE) {
    fail("EVENT_TYPE_MISMATCH", `Expected event_type=${EVENT_TYPE}`);
  }
  return structuredClone(event.client_payload);
}

export async function handleRepositoryDispatch(event, dispatcher) {
  return dispatcher.dispatch(repositoryDispatchToEnvelope(event));
}
