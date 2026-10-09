const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { braveSearchProxy } = require("../../tools/brave-search-proxy.cjs");

test("Brave relay isolates the token to a fixed endpoint and rejects cross-origin, missing-key and arbitrary-target requests", async () => {
  const calls = [];
  const server = http.createServer((req, res) =>
    braveSearchProxy(
      req,
      res,
      () => res.end("other"),
      async (url, init) => {
        calls.push({ url: String(url), init });
        if (url.searchParams.get("q") === "quota")
          return new Response(
            JSON.stringify({
              failure: "private upstream details",
              details: "x".repeat(9000),
              sentinel: "BRAVE-ERROR-END",
            }),
            {
              status: 429,
              headers: { "content-type": "application/problem+json" },
            },
          );
        if (url.searchParams.get("q") === "large")
          return new Response("x", {
            headers: { "content-length": "1048577" },
          });
        if (url.searchParams.get("q") === "broken") {
          let reads = 0;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (reads++ === 0)
                  controller.enqueue(
                    new TextEncoder().encode("PARTIAL-BRAVE-RESPONSE-END"),
                  );
                else
                  controller.error(new Error("Fixture response socket failed"));
              },
            }),
            { status: 503 },
          );
        }
        return new Response(JSON.stringify({ web: { results: [] } }));
      },
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = `${origin}/_locallab/search-api?q=Expo`;
  const headers = {
    "x-locallab-preview": "1",
    "x-subscription-token": "fixture-brave-key",
  };
  try {
    assert.equal((await fetch(target)).status, 403);
    assert.equal(
      (
        await fetch(target, {
          headers: { ...headers, origin: "https://other.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(target, { headers: { "x-locallab-preview": "1" } })).status,
      400,
    );
    assert.equal(
      (await fetch(`${target}&url=https://other.example`, { headers })).status,
      400,
    );
    assert.equal(calls.length, 0);
    const result = await fetch(target, {
      headers: {
        ...headers,
        authorization: "Bearer private",
        cookie: "private",
        "x-api-key": "private",
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(
      calls[0].url,
      "https://api.search.brave.com/res/v1/web/search?q=Expo&count=5&extra_snippets=true",
    );
    assert.deepEqual(calls[0].init.headers, {
      accept: "application/json",
      "x-subscription-token": "fixture-brave-key",
    });
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(calls[0].init.redirect, "error");
    const failed = await fetch(`${origin}/_locallab/search-api?q=quota`, {
      headers,
    });
    assert.equal(failed.status, 429);
    assert.equal(
      failed.headers.get("content-type"),
      "application/problem+json",
    );
    const failure = await failed.json();
    assert.equal(failure.failure, "private upstream details");
    assert.equal(failure.details.length, 9000);
    assert.equal(failure.sentinel, "BRAVE-ERROR-END");
    const broken = await fetch(`${origin}/_locallab/search-api?q=broken`, {
      headers,
    });
    assert.equal(broken.status, 502);
    const brokenBody = await broken.text();
    assert.match(brokenBody, /Upstream HTTP 503/);
    assert.match(brokenBody, /incomplete/);
    assert.match(brokenBody, /PARTIAL-BRAVE-RESPONSE-END/);
    assert.match(brokenBody, /Fixture response socket failed/);
    assert.equal(
      (await fetch(`${origin}/_locallab/search-api?q=large`, { headers }))
        .status,
      413,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
