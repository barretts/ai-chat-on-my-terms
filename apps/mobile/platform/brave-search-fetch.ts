import { fetch as expoFetch } from "expo/fetch";
import { tracedFetch } from "../features/diagnostics/trace-fetch";

/** Separate opt-in transport: only Brave receives this user-supplied API key. */
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
  return expoFetch(input, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    headers: {
      accept: "application/json",
      "x-subscription-token":
        new Headers(init?.headers).get("x-subscription-token") ?? "",
    },
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}, "Brave search HTTP request");
