import { ExposureError, invariant } from "./errors.mjs";

export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function responseError(provider, message, codeSuffix, status, cause = undefined) {
  return new ExposureError(message, {
    code: `${provider.toUpperCase()}_${codeSuffix}`,
    status,
    ambiguous: true,
    failoverAllowed: false,
    cause,
  });
}

export async function readBoundedJsonResponse(response, {
  provider,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  invariant(typeof provider === "string" && provider.length > 0, "A response provider name is required.", "INVALID_RESPONSE_PROVIDER");
  invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0, "maxResponseBytes must be a positive safe integer.", "INVALID_MAX_RESPONSE_BYTES");

  const declaredLength = response.headers?.get?.("content-length");
  if (/^\d+$/.test(declaredLength ?? "") && Number(declaredLength) > maxBytes) {
    throw responseError(
      provider,
      `${provider} success response exceeds the configured byte limit; review is required.`,
      "RESPONSE_TOO_LARGE",
      response.status,
    );
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw responseError(
      provider,
      `${provider} returned a success response without a readable body; review is required.`,
      "AMBIGUOUS_RESPONSE",
      response.status,
    );
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw responseError(
          provider,
          `${provider} success response exceeds the configured byte limit; review is required.`,
          "RESPONSE_TOO_LARGE",
          response.status,
        );
      }
      chunks.push(chunk);
    }
  } catch (cause) {
    if (cause instanceof ExposureError) throw cause;
    throw responseError(
      provider,
      `${provider} success response stream ended ambiguously; review is required.`,
      "AMBIGUOUS_RESPONSE",
      response.status,
      cause,
    );
  } finally {
    reader.releaseLock?.();
  }

  const rawBytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBytes);
    return { document: JSON.parse(text), rawBytes };
  } catch (cause) {
    throw responseError(
      provider,
      `${provider} returned an unreadable success response; review is required.`,
      "AMBIGUOUS_RESPONSE",
      response.status,
      cause,
    );
  }
}
