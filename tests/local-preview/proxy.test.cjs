const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { localProviderProxy } = require("../../tools/local-provider-proxy.cjs");

test("local preview relay restricts destinations, streams bytes, rejects redirects, and aborts upstream", async () => {
  let contacted = 0;
  let sawAuthorization;
  let sawCustomHeader;
  let closedStream;
  const streamClosed = new Promise((resolve) => {
    closedStream = resolve;
  });
  const upstream = http.createServer((request, response) => {
    contacted++;
    sawAuthorization = request.headers.authorization;
    sawCustomHeader = request.headers["x-local-provider"];
    if (request.url === "/redirect") {
      response.writeHead(307, { location: "/must-not-contact" });
      response.end();
    } else if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"text":"actual upstream bytes"}\n\n');
      response.on("close", closedStream);
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-coder" }] }));
    }
  });
  const relay = http.createServer((request, response) =>
    localProviderProxy(request, response, () => {
      response.writeHead(404);
      response.end();
    }),
  );
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const relayOrigin = `http://127.0.0.1:${relay.address().port}`;
  const previous = process.env.LOCALLAB_LOCAL_PROVIDER_ORIGINS;
  process.env.LOCALLAB_LOCAL_PROVIDER_ORIGINS = upstreamOrigin;
  const url = (target) =>
    `${relayOrigin}/_locallab/provider?url=${encodeURIComponent(target)}`;
  const headers = { "x-locallab-preview": "1" };
  try {
    assert.equal((await fetch(url(`${upstreamOrigin}/v1/models`))).status, 403);
    assert.equal(
      (
        await fetch(url(`${upstreamOrigin}/v1/models`), {
          headers: { ...headers, origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url("http://127.0.0.1:1/v1/models"), { headers })).status,
      403,
    );
    assert.equal(contacted, 0);
    const models = await fetch(url(`${upstreamOrigin}/v1/models`), {
      headers: {
        ...headers,
        authorization: "Bearer local-test-only",
        "x-local-provider": "selected",
      },
    });
    assert.deepEqual(await models.json(), { data: [{ id: "local-coder" }] });
    assert.equal(sawAuthorization, "Bearer local-test-only");
    assert.equal(sawCustomHeader, "selected");
    const redirect = await fetch(url(`${upstreamOrigin}/redirect`), {
      headers,
    });
    assert.equal(redirect.status, 502);
    assert.equal(contacted, 2);
    const controller = new AbortController();
    const stream = await fetch(url(`${upstreamOrigin}/stream`), {
      headers,
      signal: controller.signal,
    });
    const reader = stream.body.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /actual upstream bytes/,
    );
    controller.abort();
    await Promise.race([
      streamClosed,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Upstream stream did not close after browser cancellation",
              ),
            ),
          2000,
        ),
      ),
    ]);
    assert.equal(contacted, 3);
  } finally {
    if (previous === undefined)
      delete process.env.LOCALLAB_LOCAL_PROVIDER_ORIGINS;
    else process.env.LOCALLAB_LOCAL_PROVIDER_ORIGINS = previous;
    upstream.closeAllConnections();
    relay.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => upstream.close(resolve)),
      new Promise((resolve) => relay.close(resolve)),
    ]);
  }
});
