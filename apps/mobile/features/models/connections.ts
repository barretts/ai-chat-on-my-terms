import { createHttpTransport } from "@locallab/network-http";
import { OllamaModelService } from "@locallab/provider-ollama-models";
import { createCompatibleLocalProvider } from "@locallab/provider-compatible-local";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { modelConnectionKind, type SavedConnection } from "../connections";
import type { RemoteModelLifecyclePort } from "./index";

export { modelConnectionKind } from "../connections";

/** Inventory has no lifecycle side effects; compatible APIs do not prove loaded/downloaded state. */
export function createConnectionModels(
  connection: SavedConnection,
  secrets: SecretStore,
  fetcher: typeof fetch,
): RemoteModelLifecyclePort {
  const kind = modelConnectionKind(connection.kind);
  if (!kind)
    throw new Error(
      "This provider does not expose a supported model inventory.",
    );
  const origin = new URL(connection.host).origin;
  const transport = createHttpTransport({
    fetch: fetcher,
    policy: {
      authorizedOrigins: [origin],
      ...(origin.startsWith("http://")
        ? { cleartextLanOrigins: [origin] }
        : {}),
    },
  });
  const validate = (id: string) => {
    if (id !== connection.id)
      throw new Error("The model request does not match the selected server.");
  };
  const refs = [
    ...(connection.credentialRef
      ? [connection.credentialRef as SecretRef]
      : []),
    ...(connection.customHeadersEnabled
      ? (connection.headerRefs as SecretRef[])
      : []),
  ];
  if (kind === "ollama") {
    const service = new OllamaModelService({
      transport,
      resolveConnection: async (id) => {
        validate(id);
        return {
          baseUrl: origin,
          headers: refs.length
            ? await secrets.resolveHeaders(origin, refs)
            : {},
        };
      },
    });
    return {
      inventory: (id, selected, signal) =>
        service.inventory(id, selected, signal),
      pull: (id, model) => service.pull(id, model),
      delete: (id, model) => service.delete(id, model),
    };
  }
  const binding = {
    provider:
      kind === "jan" || kind === "omlx" || kind === "unsloth"
        ? kind
        : ("custom" as const),
    origin,
    ...(refs.length ? { headerRefs: refs } : {}),
  };
  const provider = createCompatibleLocalProvider({
    transport,
    secretStore: secrets,
    resolveConnection: async (id) => {
      validate(id);
      return binding;
    },
  });
  return {
    inventory: async (id, selected, signal) => {
      validate(id);
      return (await provider.listCompatibleModels(binding, signal)).map(
        (model) => ({
          id: model.id,
          available: true,
          selected: model.id === selected,
        }),
      );
    },
  };
}
