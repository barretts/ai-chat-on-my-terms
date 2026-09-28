import type { CatalogModel } from "@locallab/models-catalog";
import type { ModelLifecycle } from "@locallab/models-imports";
import type { ReactNode } from "react";

export interface RemoteModel {
  readonly id: string;
  readonly installed?: boolean;
  readonly loaded?: boolean;
  readonly available?: boolean;
  readonly selected: boolean;
  readonly sizeBytes?: number;
}

/** Provider lifecycle APIs stay injected so unsupported actions are never guessed. */
export interface RemoteModelLifecyclePort {
  inventory(
    connectionId: string,
    selectedModelId?: string,
    signal?: AbortSignal,
  ): Promise<readonly RemoteModel[]>;
  pull?(connectionId: string, modelId: string): RemotePullOperation;
  delete?(connectionId: string, modelId: string): Promise<void>;
  load?(connectionId: string, modelId: string): Promise<void>;
  unload?(connectionId: string, modelId: string): Promise<void>;
}
export interface RemotePullOperation {
  readonly id: string;
  cancel(): void;
  readonly result: Promise<unknown>;
  readonly progress: unknown;
}

export interface ModelFeatureDependencies {
  readonly catalog: readonly CatalogModel[];
  readonly localModelsSection?: ReactNode;
  readonly lifecycle: {
    getAll(): readonly ModelLifecycle[];
    set(value: ModelLifecycle): void;
  };
  readonly remote?: RemoteModelLifecyclePort;
  readonly connectionId?: string;
  readonly connectionName?: string;
  readonly initialSelectedModelId?: string;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onSelectModel?: (modelId: string) => void | Promise<void>;
  readonly onContextReload?: (modelId: string) => void | Promise<void>;
  readonly onImageHostUpdate?: (modelId: string) => void | Promise<void>;
}

export interface LifecycleSelectionStore {
  getAll(): readonly ModelLifecycle[];
  set(value: ModelLifecycle): void;
}

/** Updates selection locally only after the caller has confirmed context changes. */
export function applyModelSelection(
  store: LifecycleSelectionStore,
  modelId: string,
  remote?: RemoteModel,
): void {
  for (const entry of store.getAll())
    if (entry.selected) store.set({ ...entry, selected: false });
  const prior = store.getAll().find((entry) => entry.modelId === modelId);
  store.set({
    modelId,
    imported: prior?.imported ?? false,
    downloaded: prior?.downloaded ?? remote?.installed ?? false,
    selected: true,
    loaded: remote?.loaded ?? prior?.loaded ?? false,
    source: prior?.source ?? "catalog",
    ...(prior?.managedPath === undefined
      ? {}
      : { managedPath: prior.managedPath }),
    ...(prior?.jobId === undefined ? {} : { jobId: prior.jobId }),
  });
}

export function modelStatus(input: {
  readonly imported?: boolean;
  readonly downloaded?: boolean;
  readonly installed?: boolean;
  readonly selected?: boolean;
  readonly loaded?: boolean;
  readonly available?: boolean;
}): string[] {
  const states: string[] = [];
  if (input.imported) states.push("Imported");
  if (input.downloaded || input.installed) states.push("Downloaded");
  if (input.available && !input.downloaded && !input.installed)
    states.push("Available on server");
  if (input.loaded) states.push("Loaded");
  if (input.selected) states.push("Selected");
  return states.length ? states : ["Catalog"];
}
