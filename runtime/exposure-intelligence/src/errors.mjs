export class ExposureError extends Error {
  constructor(message, {
    code = "EXPOSURE_ERROR",
    status = null,
    ambiguous = false,
    failoverAllowed = false,
    retryAfterMs = null,
    details = null,
    cause = undefined,
  } = {}) {
    super(message, { cause });
    this.name = "ExposureError";
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
    this.failoverAllowed = failoverAllowed;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

export function invariant(condition, message, code = "INVALID_INPUT", details = null) {
  if (!condition) {
    throw new ExposureError(message, { code, details });
  }
}

export function publicError(error) {
  if (error instanceof ExposureError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      ambiguous: error.ambiguous,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: "Unexpected internal error.",
    status: null,
    ambiguous: false,
    retryAfterMs: null,
  };
}
