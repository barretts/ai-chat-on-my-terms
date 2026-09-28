const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

/** Local developer preview only: destinations come from the launch command. */
function localProviderProxy(request, response, next) {
  const requestUrl = new URL(request.url, "http://localhost");
  if (requestUrl.pathname === "/_locallab/preview-config") {
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        providerOrigins: (process.env.LOCALLAB_LOCAL_PROVIDER_ORIGINS ?? "")
          .split(",")
          .filter(Boolean),
      }),
    );
    return;
  }
  if (requestUrl.pathname !== "/_locallab/provider") return next();
  const host = request.headers.host ?? "";
  const expectedOrigin = `http://${host}`;
  const reject = (status, message) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: message }));
  };
  if (
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
    request.headers["x-locallab-preview"] !== "1" ||
    (request.headers.origin && request.headers.origin !== expectedOrigin) ||
    !["GET", "POST"].includes(request.method)
  )
    return reject(403, "This relay is available only to the local preview.");
  let target;
  try {
    target = new URL(requestUrl.searchParams.get("url"));
  } catch {
    return reject(400, "A valid provider URL is required.");
  }
  const allowed = (process.env.LOCALLAB_LOCAL_PROVIDER_ORIGINS ?? "").split(
    ",",
  );
  if (
    !allowed.includes(target.origin) ||
    target.username ||
    target.password ||
    target.hash ||
    !["http:", "https:"].includes(target.protocol)
  )
    return reject(
      403,
      "This provider origin was not configured for the preview.",
    );
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  void (async () => {
    const headers = {};
    const excluded = new Set([
      "host",
      "connection",
      "origin",
      "referer",
      "cookie",
      "x-locallab-preview",
      "content-length",
      "transfer-encoding",
      "accept-encoding",
    ]);
    for (const [key, value] of Object.entries(request.headers))
      if (value && !excluded.has(key) && !key.startsWith("sec-"))
        headers[key] = value;
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: controller.signal,
      ...(request.method === "POST" ? { body: request, duplex: "half" } : {}),
    });
    // The original transport cannot inspect upstream redirects through a browser relay.
    // Reject them here, without replaying credentials or contacting another destination.
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return reject(
        502,
        "Provider redirects are not supported by the local preview.",
      );
    }
    response.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.flushHeaders();
    if (upstream.body)
      await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  })().catch(() => {
    if (controller.signal.aborted) return;
    if (response.headersSent) response.destroy();
    else reject(502, "The configured provider could not be reached.");
  });
}

module.exports = { localProviderProxy };
