import { fail } from "./errors.mjs";

const FORBIDDEN_KEYS = new Set([
  "address",
  "checkpoint",
  "communication_content",
  "coordinates",
  "email",
  "emitter",
  "emitters",
  "evasion",
  "firing_position",
  "frequency",
  "frequencies",
  "geolocation",
  "latitude",
  "longitude",
  "phone",
  "position",
  "positions",
  "private_communication",
  "route",
  "routes",
  "sensor_location",
  "strike",
  "target",
  "targeting",
  "tactical_route",
  "trench",
  "trenches",
  "vulnerable_node",
  "waveform",
  "weak_point",
]);

const EXACT_ENVELOPE_KEYS = [
  "capability",
  "case_id",
  "payload",
  "sensitivity",
  "task_id",
  "worker",
];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertPlainObject(value, code = "INVALID_OBJECT") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(code, "Expected a plain JSON object");
  }
}

export function assertExactKeys(value, keys, code = "INVALID_KEYS") {
  assertPlainObject(value, code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, "Object keys do not match the required schema", {
      expected,
      actual,
    });
  }
}

export function assertNoForbiddenFields(value, path = "payload") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoForbiddenFields(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (FORBIDDEN_KEYS.has(normalized)) {
      fail("FORBIDDEN_FIELD", `Forbidden field at ${path}.${key}`);
    }
    assertNoForbiddenFields(child, `${path}.${key}`);
  }
}

export function validateEnvelope(input) {
  assertExactKeys(input, EXACT_ENVELOPE_KEYS, "INVALID_ENVELOPE");

  for (const key of ["task_id", "case_id", "worker", "capability"]) {
    if (typeof input[key] !== "string" || !SAFE_ID.test(input[key])) {
      fail("INVALID_ENVELOPE", `${key} is not a valid identifier`);
    }
  }
  if (input.sensitivity !== "PUBLIC") {
    fail("SENSITIVITY_REJECTED", "Only PUBLIC tasks are accepted");
  }
  assertPlainObject(input.payload, "INVALID_PAYLOAD");
  assertNoForbiddenFields(input.payload);

  return structuredClone(input);
}

export function parseEnvelope(jsonText) {
  if (typeof jsonText !== "string") {
    fail("INVALID_JSON", "Envelope must be supplied as JSON text");
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    fail("INVALID_JSON", "Envelope is not valid JSON");
  }
  return validateEnvelope(parsed);
}
