import { tracedFetch } from "../features/diagnostics/trace-fetch";
export const braveSearchFetch: typeof fetch = tracedFetch((input, init) => {
  const target = new URL(String(input));
  if (
    target.origin !== "https://api.search.brave.com" ||
    target.pathname !== "/res/v1/web/search" ||
    target.username ||
    target.password
  )
    return Promise.reject(
      new Error("Only the configured Brave Search service is supported."),
    );
  const headers = {
    accept: "application/json",
    "x-subscription-token":
      new Headers(init?.headers).get("x-subscription-token") ?? "",
  };
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    window.location.hostname,
  );
  const url = local
    ? new URL("/_locallab/search-api", window.location.origin)
    : target;
  if (local) url.searchParams.set("q", target.searchParams.get("q") ?? "");
  return fetch(url, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    headers: local ? { ...headers, "x-locallab-preview": "1" } : headers,
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}, "Brave search HTTP request");
