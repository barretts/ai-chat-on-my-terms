/** The local preview can relay explicitly configured servers that reject browser CORS. */
import { tracedFetch } from "../features/diagnostics/trace-fetch";
let previewOrigins: Promise<readonly string[]> | undefined;
const previewProviderFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.href,
  );
  const localPreview = ["localhost", "127.0.0.1", "[::1]"].includes(
    window.location.hostname,
  );
  if (!localPreview) return fetch(input, init);
  previewOrigins ??= fetch("/_locallab/preview-config")
    .then(async (response) => {
      if (!response.ok) return [];
      const config: unknown = await response.json();
      if (
        !config ||
        typeof config !== "object" ||
        !("providerOrigins" in config)
      )
        return [];
      const origins = config.providerOrigins;
      return Array.isArray(origins) &&
        origins.every((origin) => typeof origin === "string")
        ? origins
        : [];
    })
    .catch(() => []);
  if (!(await previewOrigins).includes(url.origin)) return fetch(input, init);
  const headers = new Headers(
    input instanceof Request ? input.headers : init?.headers,
  );
  headers.set("x-locallab-preview", "1");
  const relay = new URL("/_locallab/provider", window.location.origin);
  relay.searchParams.set("url", url.toString());
  const response = await fetch(relay, { ...init, headers });
  // Redirects are rejected by the relay. Preserve the effective provider URL
  // so the app's existing cross-origin redirect guards still check that URL.
  Object.defineProperty(response, "url", { value: url.toString() });
  return response;
};
export const providerFetch = tracedFetch(
  previewProviderFetch,
  "Model HTTP request",
);
