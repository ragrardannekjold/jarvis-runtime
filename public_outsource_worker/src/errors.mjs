export class WorkerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new WorkerError(code, message, details);
}
