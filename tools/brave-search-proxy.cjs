/** A fixed-endpoint relay for a user's optional Brave Search key. No arbitrary URLs. */
function braveSearchProxy(request, response, next, fetcher = fetch) {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/_locallab/search-api") return next();
  const reject = (status, message) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ error: message }));
  };
  const host = request.headers.host ?? "";
  if (
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
    request.method !== "GET" ||
    request.headers["x-locallab-preview"] !== "1" ||
    (request.headers.origin && request.headers.origin !== `http://${host}`)
  )
    return reject(
      403,
      "Search API access is available only to the local preview.",
    );
  const query = url.searchParams.get("q")?.trim();
  const token = request.headers["x-subscription-token"];
  if (
    [...url.searchParams.keys()].length !== 1 ||
    !query ||
    query.length > 500 ||
    query.split(/\s+/).length > 75 ||
    typeof token !== "string" ||
    !token.trim() ||
    token.length > 512 ||
    /[\r\n]/.test(token)
  )
    return reject(
      400,
      "A valid search question and Brave Search key are required.",
    );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  void (async () => {
    const target = new URL("https://api.search.brave.com/res/v1/web/search");
    target.searchParams.set("q", query);
    target.searchParams.set("count", "5");
    target.searchParams.set("extra_snippets", "true");
    const upstream = await fetcher(target, {
      method: "GET",
      headers: { accept: "application/json", "x-subscription-token": token },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    // Preserve full upstream failures; only successful research content is
    // bounded. The app redacts the registered token before display/persistence.
    const maximum = upstream.ok ? 1_048_576 : Infinity;
    if (Number(upstream.headers.get("content-length")) > maximum) {
      await upstream.body?.cancel();
      return reject(413, "The search response is too large.");
    }
    if (!upstream.body && upstream.ok)
      return reject(502, "Brave Search returned an empty response.");
    if (!upstream.body) {
      response.writeHead(upstream.status, upstream.statusText, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return response.end();
    }
    const reader = upstream.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    if (controller.signal.aborted) cancel();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted)
          throw new Error("Search request canceled");
        if (done) break;
        size += value.byteLength;
        if (size > maximum)
          return reject(413, "The search response is too large.");
        chunks.push(Buffer.from(value));
      }
    } catch (cause) {
      // A broken response must retain the bytes already received. The app
      // redacts this body and makes the incomplete response explicit.
      const failure = cause instanceof Error ? cause.message : String(cause);
      return reject(
        controller.signal.aborted ? 504 : 502,
        `Brave Search response could not be read completely.\nUpstream HTTP ${upstream.status}.\nResponse body (incomplete):\n${Buffer.concat(chunks).toString("utf8") || "[empty]"}\n${failure}`,
      );
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    response.writeHead(upstream.status, upstream.statusText, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(Buffer.concat(chunks));
  })()
    .catch(() => {
      if (response.destroyed) return;
      reject(
        controller.signal.aborted ? 504 : 502,
        "Brave Search could not finish. Try again.",
      );
    })
    .finally(() => clearTimeout(timer));
}
module.exports = { braveSearchProxy };
