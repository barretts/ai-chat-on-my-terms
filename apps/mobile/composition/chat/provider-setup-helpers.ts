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
  type FetchLike,
} from "@locallab/network-http";
import { CLOUD_COMPATIBLE_PRESETS } from "@locallab/provider-cloud-compatible";

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
  if (!models.ok) throw new Error(models.error.message);
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
    const payload: unknown = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      !("data" in payload) ||
      !payload.data ||
      typeof payload.data !== "object" ||
      Array.isArray(payload.data)
    )
      throw new Error("OpenRouter returned an invalid key-check response.");
  } catch (error) {
    if (
      error instanceof HttpTransportError &&
      [401, 403].includes(error.status ?? 0)
    )
      throw new Error(
        "OpenRouter rejected this API key. Check the key and try again.",
      );
    if (error instanceof HttpTransportError && error.status === 429)
      throw new Error(
        "OpenRouter is rate limiting key checks. Try again shortly.",
      );
    throw new Error(
      "OpenRouter key validation could not be completed. Try again.",
    );
  }
}
