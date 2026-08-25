import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizePublicUrl,
  diffSnapshots,
  harvestPublicUrl,
  snapshotPublicDocument,
} from "./harvester.mjs";

const allowedOrigins = ["https://public.example"];

test("canonicalizes only allowlisted public HTTPS URLs", () => {
  assert.equal(
    canonicalizePublicUrl("https://public.example/docs?id=7&utm_source=test#section", { allowedOrigins }),
    "https://public.example/docs?id=7",
  );
  assert.throws(
    () => canonicalizePublicUrl("https://other.example/docs", { allowedOrigins }),
    /origin_not_allowlisted/,
  );
  assert.throws(
    () => canonicalizePublicUrl("http://public.example/docs", { allowedOrigins }),
    /https_url_required/,
  );
  assert.throws(
    () => canonicalizePublicUrl("https://127.0.0.1/docs", { allowedOrigins: ["https://127.0.0.1"] }),
    /non_public_hostname_rejected/,
  );
});

test("creates deterministic semantic snapshots and detects meaningful change", () => {
  const first = snapshotPublicDocument({
    url: "https://public.example/page",
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", etag: "a" },
    fetchedAt: "2026-08-25T12:00:00.000Z",
    body: "<html><head><title>Alpha</title></head><body><p>Network build 10 sites</p></body></html>",
  });
  const formattingOnly = snapshotPublicDocument({
    url: "https://public.example/page",
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", etag: "b" },
    fetchedAt: "2026-08-25T13:00:00.000Z",
    body: "<html>\n<head><title>Alpha</title></head>\n<body> <p>Network build 10 sites</p> </body>\n</html>",
  });
  const changed = snapshotPublicDocument({
    url: "https://public.example/page",
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", etag: "c" },
    fetchedAt: "2026-08-25T14:00:00.000Z",
    body: "<html><head><title>Alpha</title></head><body><p>Network build 25 sites</p></body></html>",
  });

  assert.equal(first.normalized_text_sha256, formattingOnly.normalized_text_sha256);
  assert.equal(diffSnapshots(first, formattingOnly).semantic_changed, false);
  assert.equal(diffSnapshots(formattingOnly, changed).semantic_changed, true);
});

test("harvests through an injected fetch implementation without live network access", async () => {
  let seenUrl = null;
  const fetchImpl = async (url) => {
    seenUrl = url;
    return new Response(
      "<html><head><title>Evidence</title></head><body>Public document revision 3</body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };

  const snapshot = await harvestPublicUrl(
    "https://public.example/report?utm_campaign=noise&id=3",
    {
      allowedOrigins,
      fetchImpl,
      now: () => new Date("2026-08-25T15:00:00.000Z"),
    },
  );

  assert.equal(seenUrl, "https://public.example/report?id=3");
  assert.equal(snapshot.url, "https://public.example/report?id=3");
  assert.equal(snapshot.title, "Evidence");
  assert.equal(snapshot.http_status, 200);
  assert.equal(snapshot.fetched_at, "2026-08-25T15:00:00.000Z");
});
