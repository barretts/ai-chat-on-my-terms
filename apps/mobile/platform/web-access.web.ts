/** The desktop preview relays two fixed public services to avoid browser CORS. */
import { tracedFetch } from "../features/diagnostics/trace-fetch";
export const webAccessFetch: typeof fetch = tracedFetch((input, init) => {
  const target = String(input);
  if (["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) {
    const url = new URL("/_locallab/web", window.location.origin);
    url.searchParams.set("url", target);
    return fetch(url, {
      method: "GET",
      headers: { "x-locallab-preview": "1" },
      credentials: "omit",
      redirect: "error",
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  }
  return fetch(input, {
    method: "GET",
    headers: {
      accept: target.startsWith("https://r.jina.ai/")
        ? "application/json"
        : "text/html",
    },
    credentials: "omit",
    redirect: "error",
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}, "Public web HTTP request");
