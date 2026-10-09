import type { FetchLike } from "@locallab/network-http";
import type { SecretStore } from "@locallab/security-secrets";
import {
  createRegisteredChatProvider,
  type ChatProviderRegistration,
} from "../../composition/chat/providers";
import { createConnectionModels } from "./connections";
import type { RemoteModelLifecyclePort } from "./index";

/** Use the exact connection selected in chat; only Ollama exposes download/delete here. */
export function createRegisteredConnectionModels(
  connection: ChatProviderRegistration,
  secrets: SecretStore,
  fetcher: FetchLike,
): RemoteModelLifecyclePort {
  if (connection.kind === "ollama") {
    if (!connection.endpoint)
      throw new Error("This connection needs a server address.");
    if (
      connection.endpoint.startsWith("http:") &&
      !connection.cleartextAuthorized
    )
      throw new Error(
        "Allow this local connection in Connections before loading models.",
      );
    return createConnectionModels(
      {
        id: connection.id,
        name: connection.label,
        kind: connection.kind,
        host: connection.endpoint,
        credentialRef: connection.credentialRef ?? null,
        headerRefs: connection.headerRefs ?? [],
        customHeadersEnabled: !!connection.headerRefs?.length,
        position: 0,
        createdAt: "",
        updatedAt: "",
      },
      secrets,
      fetcher as typeof fetch,
    );
  }
  return {
    async inventory(connectionId, selected, signal) {
      if (connectionId !== connection.id)
        throw new Error(
          "Choose this connection again before loading its models.",
        );
      const provider = createRegisteredChatProvider(connection, {
        secrets,
        fetch: fetcher,
      });
      try {
        const result = await provider.listModels(undefined, signal);
        if (!result.ok) throw new Error(result.error.message);
        return [...new Set(result.value)].map((id) => ({
          id,
          available: true,
          selected: id === selected,
        }));
      } finally {
        await provider.dispose?.();
      }
    },
  };
}
