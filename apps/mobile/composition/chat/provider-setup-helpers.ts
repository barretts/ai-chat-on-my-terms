import type {
  SecretDescriptor,
  SecretRef,
  SecretStore,
} from "@locallab/security-secrets";
import type { ChatProviderKind } from "./providers";
import type { ProviderPort } from "@locallab/contracts/ports";
import {
  createHttpTransport,
  HttpTransportError,
  errorDetails,
  type FetchLike,
} from "@locallab/network-http";
import { CLOUD_COMPATIBLE_PRESETS } from "@locallab/provider-cloud-compatible";

export const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

/** Check the selected adapter's protocol before saving keys or making requests. */
export function validateProviderEndpoint(
  kind: ChatProviderKind,
  endpoint: string,
  cleartextAuthorized: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error(
      kind === "openai"
        ? `Enter a complete OpenAI Responses endpoint, such as ${OPENAI_RESPONSES_ENDPOINT}.`
        : "Enter a complete endpoint, such as http://192.168.1.213:35961/v1.",
    );
  }
  if (kind === "openai") {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/\/responses\/?$/i.test(url.pathname)
    )
      throw new Error(
        `OpenAI uses the Responses API. Enter an HTTPS /responses endpoint without credentials, a query, or a fragment, such as ${OPENAI_RESPONSES_ENDPOINT}. For a /v1 or /chat/completions server, choose Local server or Custom cloud API.`,
      );
    return url;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Use an HTTP or HTTPS endpoint without credentials in the URL.",
    );
  if (
    ["jan", "omlx", "unsloth", "compatible"].includes(kind) &&
    !["/", "/v1", "/v1/"].includes(url.pathname)
  )
    throw new Error("Use the compatible server origin or its /v1 API base.");
  if (url.protocol === "http:" && !cleartextAuthorized)
    throw new Error("Allow this local HTTP origin before connecting.");
  return url;
}

/** Store the form's API key in the shape consumed by the selected adapter. */
export function putProviderCredential(
  secrets: SecretStore,
  kind: ChatProviderKind,
  origin: string,
  apiKey: string,
): Promise<SecretDescriptor> {
  const key = apiKey.trim().replace(/^(?:Bearer(?:\s+|$))+/i, "");
  if (!key || /[\r\n]/.test(apiKey))
    throw new TypeError("Enter a valid provider API key.");
  if (kind === "anthropic") return secrets.put(origin, "x-api-key", key);
  if (kind === "gemini") return secrets.put(origin, "x-goog-api-key", key);
  if (kind === "openai") return secrets.put(origin, "authorization", key);
  return secrets.put(origin, "authorization", `Bearer ${key}`);
}

/** A configured model ID is verified only when the server actually lists it. */
export async function requireListedProviderModel(
  port: ProviderPort,
  modelId: string,
  signal?: AbortSignal,
): Promise<void> {
  const models = await port.listModels(undefined, signal);
  if (!models.ok) throw models.error;
  if (!models.value.includes(modelId))
    throw new Error(
      `Server responded, but it does not list ${modelId}. Available models: ${models.value.join(", ") || "none"}.`,
    );
}

/** OpenRouter's public catalog does not prove that a supplied key is valid. */
export async function verifyOpenRouterCredential(
  secrets: SecretStore,
  ref: SecretRef,
  fetch: FetchLike,
  signal?: AbortSignal,
): Promise<void> {
  const origin = new URL(CLOUD_COMPATIBLE_PRESETS.openrouter).origin;
  try {
    const headers = await secrets.resolveHeaders(origin, [ref]);
    const transport = createHttpTransport({
      fetch,
      policy: { authorizedOrigins: [origin] },
    });
    const response = await transport.request(
      `${CLOUD_COMPATIBLE_PRESETS.openrouter}/key`,
      { headers, ...(signal ? { signal } : {}) },
    );
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (cause) {
      throw new Error(
        `OpenRouter returned an unreadable key-check response (HTTP ${response.status} ${response.statusText}).\n${errorDetails(cause)}\nResponse body:\n${raw}`,
        { cause },
      );
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      !("data" in payload) ||
      !payload.data ||
      typeof payload.data !== "object" ||
      Array.isArray(payload.data)
    )
      throw new Error(
        `OpenRouter returned an invalid key-check response (HTTP ${response.status} ${response.statusText}).\nResponse body:\n${raw}`,
      );
  } catch (error) {
    if (
      error instanceof HttpTransportError &&
      [401, 403].includes(error.status ?? 0)
    )
      throw new Error(
        `OpenRouter rejected this API key (HTTP ${error.status} from ${CLOUD_COMPATIBLE_PRESETS.openrouter}/key). Check the key and try again.\n${errorDetails(error)}`,
        { cause: error },
      );
    if (error instanceof HttpTransportError && error.status === 429)
      throw new Error(
        `OpenRouter is rate limiting key checks (HTTP 429 from ${CLOUD_COMPATIBLE_PRESETS.openrouter}/key). Try again shortly.\n${errorDetails(error)}`,
        { cause: error },
      );
    throw new Error(
      `OpenRouter key validation could not be completed at ${CLOUD_COMPATIBLE_PRESETS.openrouter}/key. Try again.\n${errorDetails(error)}`,
      { cause: error },
    );
  }
}
