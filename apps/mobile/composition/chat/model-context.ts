import { createHttpTransport, type FetchLike } from "@locallab/network-http";
import {
  createCompatibleLocalProvider,
  type CompatibleModelContext,
} from "@locallab/provider-compatible-local";
import type { SecretStore } from "@locallab/security-secrets";
import type { ChatProviderRegistration } from "./providers";

const compatibleKinds = new Set([
  "compatible",
  "jan",
  "omlx",
  "unsloth",
  "lmstudio",
  "cloud-compatible",
]);

/** Context defaults belong to the exact connection and model, never a shared model-name preset. */
export function modelContextKey(connection: ChatProviderRegistration): string {
  return JSON.stringify([
    connection.id,
    connection.kind,
    connection.endpoint,
    connection.modelId,
    connection.cleartextAuthorized === true,
    connection.credentialRef ?? null,
    connection.headerRefs ?? [],
  ]);
}

export function supportsContextDiscovery(
  connection: ChatProviderRegistration,
): boolean {
  if (!compatibleKinds.has(connection.kind) || !connection.endpoint)
    return false;
  try {
    const url = new URL(connection.endpoint);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["/", "/v1", "/v1/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Reads active server limits without changing user presets or loading a model. */
export async function discoverRegisteredModelContext(
  connection: ChatProviderRegistration,
  options: { fetch: FetchLike; secrets: SecretStore },
  signal?: AbortSignal,
): Promise<CompatibleModelContext | undefined> {
  if (!supportsContextDiscovery(connection)) return undefined;
  const endpoint = new URL(connection.endpoint!);
  const transport = createHttpTransport({
    fetch: options.fetch,
    policy: {
      authorizedOrigins: [endpoint.origin],
      cleartextLanOrigins:
        endpoint.protocol === "http:" && connection.cleartextAuthorized
          ? [endpoint.origin]
          : [],
    },
  });
  const selected = {
    provider: "custom" as const,
    origin: endpoint.origin,
    ...(connection.credentialRef
      ? { credentialRef: connection.credentialRef }
      : {}),
    ...(connection.headerRefs ? { headerRefs: connection.headerRefs } : {}),
  };
  return createCompatibleLocalProvider({
    transport,
    secretStore: options.secrets,
    resolveConnection: async () => selected,
  }).discoverCompatibleModelContext(selected, connection.modelId, signal);
}
