export interface EmbeddingModelDescriptor {
  id: string;
  dimensions: number;
  local: true;
  installed: boolean;
  /** Human readable artifact identity; changes force a complete reindex. */
  revision: string;
}

export interface LocalEmbeddingRuntime {
  readonly model: EmbeddingModelDescriptor;
  embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]>;
}

/** Resolve only an installed local runtime. Remote providers are intentionally excluded. */
export function selectLocalEmbeddingModel(
  runtimes: readonly LocalEmbeddingRuntime[],
  preferredId?: string,
): LocalEmbeddingRuntime | undefined {
  const candidates = runtimes.filter(
    (runtime) => runtime.model.local && runtime.model.installed,
  );
  return (
    candidates.find((runtime) => runtime.model.id === preferredId) ??
    candidates[0]
  );
}

export function embeddingIdentity(runtime: LocalEmbeddingRuntime): string {
  return `${runtime.model.id}@${runtime.model.revision}:${runtime.model.dimensions}`;
}

export function validateEmbedding(
  vector: readonly number[],
  dimensions: number,
): void {
  if (
    vector.length !== dimensions ||
    vector.length === 0 ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Embedding runtime returned an invalid vector");
  }
}
