import { fetch as expoFetch } from "expo/fetch";
import { tracedFetch } from "../features/diagnostics/trace-fetch";

/** Web research uses its own credential-free transport, never provider headers. */
export const webAccessFetch: typeof fetch = tracedFetch(
  (input, init) =>
    expoFetch(input, {
      method: "GET",
      headers: {
        accept: String(input).startsWith("https://r.jina.ai/")
          ? "application/json"
          : "text/html",
      },
      credentials: "omit",
      redirect: "error",
      ...(init?.signal ? { signal: init.signal } : {}),
    }),
  "Public web HTTP request",
);
