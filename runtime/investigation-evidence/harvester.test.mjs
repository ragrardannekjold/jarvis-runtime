import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizePublicUrl,
  diffSnapshots,
  harvestPublicUrl,
  snapshotPublicDocument,
} from "./harvester.mjs";

const allowedOrigins = ["https://public.example"];
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

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
  assert.throws(
    () => canonicalizePublicUrl("https://[::ffff:127.0.0.1]/docs", { allowedOrigins: ["https://[::ffff:127.0.0.1]"] }),
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

test("harvests through injected fetch and DNS implementations without live network access", async () => {
  let seenUrl = null;
  let seenRedirectMode = null;
  const fetchImpl = async (url, options) => {
    seenUrl = url;
    seenRedirectMode = options.redirect;
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
      lookupImpl: publicLookup,
      now: () => new Date("2026-08-25T15:00:00.000Z"),
    },
  );

  assert.equal(seenUrl, "https://public.example/report?id=3");
  assert.equal(seenRedirectMode, "manual");
  assert.equal(snapshot.url, "https://public.example/report?id=3");
  assert.equal(snapshot.title, "Evidence");
  assert.equal(snapshot.http_status, 200);
  assert.equal(snapshot.fetched_at, "2026-08-25T15:00:00.000Z");
});

test("rejects a hostname that resolves to a private address before fetch", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () => harvestPublicUrl("https://public.example/report", {
      allowedOrigins,
      lookupImpl: async () => [{ address: "10.0.0.7", family: 4 }],
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("should not fetch");
      },
    }),
    /non_public_dns_resolution_rejected/,
  );
  assert.equal(fetchCalls, 0);
});

test("rejects redirects to non-allowlisted origins before following them", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://other.example/hidden" },
    });
  };

  await assert.rejects(
    () => harvestPublicUrl("https://public.example/start", {
      allowedOrigins,
      lookupImpl: publicLookup,
      fetchImpl,
    }),
    /origin_not_allowlisted/,
  );
  assert.equal(fetchCalls, 1);
});

test("follows an allowlisted redirect only after re-validating the next hop", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith("/start")) {
      return new Response(null, {
        status: 302,
        headers: { location: "/final?utm_source=noise&id=9" },
      });
    }
    return new Response("<html><head><title>Final</title></head><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };

  const snapshot = await harvestPublicUrl("https://public.example/start", {
    allowedOrigins,
    lookupImpl: publicLookup,
    fetchImpl,
  });

  assert.deepEqual(seen, [
    "https://public.example/start",
    "https://public.example/final?id=9",
  ]);
  assert.equal(snapshot.url, "https://public.example/final?id=9");
  assert.equal(snapshot.title, "Final");
});
