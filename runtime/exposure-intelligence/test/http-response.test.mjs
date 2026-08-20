import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedJsonResponse } from "../src/http-response.mjs";

test("streaming response limit applies without Content-Length", async () => {
  const response = new Response(JSON.stringify({ padding: "x".repeat(256) }), { status: 200 });
  await assert.rejects(
    readBoundedJsonResponse(response, { provider: "censys", maxBytes: 64 }),
    (error) => error.code === "CENSYS_RESPONSE_TOO_LARGE"
      && error.ambiguous === true
      && error.failoverAllowed === false,
  );
});

test("malformed UTF-8 success bytes are ambiguous instead of replacement-decoded", async () => {
  const prefix = Buffer.from('{"result":{"hits":[],"next_page_token":"","x":"');
  const suffix = Buffer.from('"}}');
  const response = new Response(Buffer.concat([prefix, Buffer.from([0xff]), suffix]), { status: 200 });
  await assert.rejects(
    readBoundedJsonResponse(response, { provider: "censys", maxBytes: 1024 }),
    (error) => error.code === "CENSYS_AMBIGUOUS_RESPONSE"
      && error.ambiguous === true
      && error.failoverAllowed === false,
  );
});

test("valid UTF-8 BOM and multibyte JSON decode without changing raw bytes", async () => {
  const raw = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"city":"Київ"}', "utf8"),
  ]);
  const result = await readBoundedJsonResponse(new Response(raw, { status: 200 }), {
    provider: "censys",
    maxBytes: 1024,
  });
  assert.equal(result.document.city, "Київ");
  assert.deepEqual(result.rawBytes, raw);
});
