const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const {
  webResearchProxy,
  isResearchService,
} = require("../../tools/web-research-proxy.cjs");

test("research relay permits only fixed services and public pages", () => {
  for (const target of [
    "https://example.com",
    "https://r.jina.ai/http://localhost/",
    "https://r.jina.ai/http://192.168.1.213/",
    "https://r.jina.ai/http://[::1]/",
    "https://r.jina.ai/https://user:password@example.com",
    "https://html.duckduckgo.com/?q=hello",
    "https://html.duckduckgo.com/html/?q=hello&redirect=evil",
    "https://html.duckduckgo.com/html/?q=hello&q=second",
    "https://lite.duckduckgo.com/html/?q=hello",
    "https://lite.duckduckgo.com/lite/?q=hello&api_key=secret",
  ])
    assert.equal(isResearchService(new URL(target)), false, target);
  for (const target of [
    "https://html.duckduckgo.com/html/?q=hello",
    "https://lite.duckduckgo.com/lite/?q=hello",
    "https://r.jina.ai/https://docs.expo.dev/",
    "https://r.jina.ai/https://example.com/article?language=en",
  ])
    assert.equal(isResearchService(new URL(target)), true, target);
});
test("relay drops credentials, denies cross-origin calls, forwards errors and limits responses", async () => {
  const calls = [];
  const server = http.createServer((req, res) =>
    webResearchProxy(
      req,
      res,
      () => res.end("other"),
      async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("rate-limited"))
          return new Response(
            JSON.stringify({
              failure: "private service detail",
              details: "x".repeat(9000),
              sentinel: "PUBLIC-ERROR-END",
            }),
            {
              status: 429,
              headers: { "content-type": "application/problem+json" },
            },
          );
        if (String(url).includes("too-large"))
          return new Response("x", {
            headers: { "content-length": "1048577" },
          });
        return new Response("public page content");
      },
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = (url) =>
    `${origin}/_locallab/web?url=${encodeURIComponent(url)}`;
  const url = target("https://r.jina.ai/https://example.com/");
  const headers = { "x-locallab-preview": "1" };
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal(
      (
        await fetch(url, {
          headers: { ...headers, origin: "https://other.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(target("http://127.0.0.1/"), { headers })).status,
      403,
    );
    assert.equal(calls.length, 0);
    const response = await fetch(url, {
      headers: {
        ...headers,
        authorization: "Bearer must-not-leak",
        cookie: "must-not-leak",
        "x-api-key": "must-not-leak",
      },
    });
    assert.equal(await response.text(), "public page content");
    assert.deepEqual(calls[0].init.headers, {
      accept: "application/json",
    });
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(
      (
        await fetch(target("https://lite.duckduckgo.com/lite/?q=hello"), {
          headers,
        })
      ).status,
      200,
    );
    assert.deepEqual(calls[1].init.headers, { accept: "text/html" });
    const failed = await fetch(
      target("https://r.jina.ai/https://example.com/rate-limited"),
      { headers },
    );
    assert.equal(failed.status, 429);
    assert.equal(
      failed.headers.get("content-type"),
      "application/problem+json",
    );
    const failure = await failed.json();
    assert.equal(failure.failure, "private service detail");
    assert.equal(failure.details.length, 9000);
    assert.equal(failure.sentinel, "PUBLIC-ERROR-END");
    assert.equal(
      (
        await fetch(target("https://r.jina.ai/https://example.com/too-large"), {
          headers,
        })
      ).status,
      413,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
