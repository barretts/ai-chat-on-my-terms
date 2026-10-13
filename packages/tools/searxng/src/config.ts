import { SearxngError } from "./errors";

/** Configuration for one configured SearXNG instance. */
export interface SearxngConfig {
  /** Configured instance base URL, http or https, no path required
   * (path prefix allowed). */
  baseUrl: string;
  /** Optional Bearer/custom headers as RESOLVED VALUES. This package never
   * sees secret refs. */
  headers?: Record<string, string>;
  /** Two-letter-ish language filter passed as ?language= (optional). */
  language?: string;
  /** Comma list passed as ?categories= (optional). */
  categories?: string;
  /** Per-request deadline; default 20_000 ms. */
  timeoutMs?: number;
  /** Max results kept; default 10, hard cap 20. */
  maxResults?: number;
  /** Max UTF-8 bytes kept per result text; default 4000, hard cap 8000. */
  maxTextBytes?: number;
}

/** Validates the configured base URL and returns its canonical absolute
 * form (origin plus path prefix, no trailing slash). Rejects non-absolute
 * inputs, non-http(s) protocols, and URLs carrying userinfo credentials
 * with a {@link SearxngError} whose code is "malformed-config". */
export function normalizeSearxngBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SearxngError(
      "malformed-config",
      `The SearXNG base URL "${input}" is not an absolute URL; ` +
        "expected http://host[:port][/path] or https://host[/path].",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new SearxngError(
      "malformed-config",
      `The SearXNG base URL "${input}" must use http or https, ` +
        `not "${url.protocol}".`,
    );
  if (url.username !== "" || url.password !== "")
    throw new SearxngError(
      "malformed-config",
      `The SearXNG base URL "${input}" must not embed credentials; ` +
        "authentication must use configured headers.",
    );
  if (url.pathname === "/") return url.origin;
  return url.origin + url.pathname.replace(/\/+$/, "");
}
