const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

function isPublicPage(input) {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.port &&
      host.includes(".") &&
      /^[a-z0-9.-]+$/.test(host) &&
      !/^[\d.]+$/.test(host) &&
      !/(?:^|\.)(?:localhost|local|lan|internal|home|test|invalid)$/.test(
        host,
      ) &&
      url.toString().length <= 2048
    );
  } catch {
    return false;
  }
}

function isResearchService(url) {
  if (url.username || url.password || url.hash || url.port) return false;
  if (
    url.origin === "https://html.duckduckgo.com" ||
    url.origin === "https://lite.duckduckgo.com"
  )
    return (
      url.pathname ===
        (url.hostname.startsWith("lite.") ? "/lite/" : "/html/") &&
      [...url.searchParams.keys()].length === 1 &&
      [...url.searchParams.keys()].every((key) => key === "q") &&
      !!url.searchParams.get("q")?.trim() &&
      url.searchParams.get("q").length <= 500
    );
  return (
    url.origin === "https://r.jina.ai" &&
    isPublicPage(url.pathname.slice(1) + url.search)
  );
}

/** No arbitrary proxy, cookies, saved model keys or private-network requests. */
function webResearchProxy(request, response, next, fetcher = fetch) {
  const requestUrl = new URL(request.url, "http://localhost");
  if (requestUrl.pathname !== "/_locallab/web") return next();
  const reject = (status, error) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ error }));
  };
  const host = request.headers.host ?? "";
  if (
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
    request.method !== "GET" ||
    request.headers["x-locallab-preview"] !== "1" ||
    (request.headers.origin && request.headers.origin !== `http://${host}`)
  )
    return reject(403, "Web research is available only to the local preview.");
  let target;
  try {
    target = new URL(requestUrl.searchParams.get("url"));
  } catch {
    return reject(400, "A valid research URL is required.");
  }
  if (!isResearchService(target))
    return reject(403, "Only public search and page reading are supported.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  void (async () => {
    const upstream = await fetcher(target, {
      method: "GET",
      headers: {
        accept:
          target.hostname === "r.jina.ai" ? "application/json" : "text/html",
      },
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
    // Successful research content is bounded. Failures retain their complete
    // upstream body so the app can display/copy it after credential redaction.
    const maximum = upstream.ok ? 1_048_576 : Infinity;
    if (Number(upstream.headers.get("content-length")) > maximum) {
      await upstream.body?.cancel();
      return reject(413, "The web response is too large.");
    }
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > maximum ? new Error("Web response too large") : null,
          chunk,
        );
      },
    });
    response.writeHead(upstream.status, upstream.statusText, {
      "content-type": upstream.headers.get("content-type") ?? "text/plain",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (upstream.body)
      await pipeline(Readable.fromWeb(upstream.body), limiter, response);
    else response.end();
  })()
    .catch(() => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else
        reject(
          controller.signal.aborted ? 504 : 502,
          "Web research could not finish. Try again.",
        );
    })
    .finally(() => clearTimeout(timer));
}

module.exports = { webResearchProxy, isResearchService };
