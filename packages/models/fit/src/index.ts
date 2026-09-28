import type { CatalogModel } from "@locallab/models-catalog";

export type FitTier = "faster" | "balanced" | "best";
export type FitMode = "beginner" | "power";
export interface DeviceFitFacts {
  readonly availableMemoryBytes: number | null;
  readonly availableStorageBytes: number | null;
  readonly supportedFormats: readonly ("gguf" | "mlx" | "safetensors")[];
}
export interface ModelFitChoice {
  readonly tier: FitTier;
  readonly model: CatalogModel;
  readonly estimatedWorkingSetBytes: number;
  readonly storageRequiredBytes: number;
  readonly confidence: "estimated";
}

/** Conservative fit estimates. Unknown model size or hardware facts never become a positive fit claim. */
export function recommendModelFits(
  models: readonly CatalogModel[],
  facts: DeviceFitFacts,
  format: "gguf" | "mlx" | "safetensors",
): readonly ModelFitChoice[] {
  if (
    !validResource(facts.availableMemoryBytes) ||
    !validResource(facts.availableStorageBytes) ||
    !facts.supportedFormats.includes(format)
  )
    return [];
  const candidates = models
    .filter(
      (model) =>
        model.formats.includes(format) && model.sizeBytes !== undefined,
    )
    .map((model) => ({
      model,
      storage: model.sizeBytes!,
      working: Math.ceil(
        model.sizeBytes! * (format === "mlx" ? 1.65 : 1.35) + 512 * 1024 ** 2,
      ),
    }))
    .filter(
      ({ storage, working }) =>
        storage <= facts.availableStorageBytes! * 0.8 &&
        working <= facts.availableMemoryBytes! * 0.8,
    )
    .sort(
      (left, right) =>
        left.storage - right.storage ||
        left.model.id.localeCompare(right.model.id),
    );
  if (!candidates.length) return [];

  const faster = candidates[0]!;
  const balancedTarget = facts.availableMemoryBytes * 0.35;
  const balanced = candidates.reduce((best, item) =>
    Math.abs(item.working - balancedTarget) <
    Math.abs(best.working - balancedTarget)
      ? item
      : best,
  );
  const best = candidates[candidates.length - 1]!;
  const selected = new Map<FitTier, typeof faster>([
    ["faster", faster],
    ["balanced", balanced],
    ["best", best],
  ]);
  return [...selected].map(([tier, item]) => ({
    tier,
    model: item.model,
    estimatedWorkingSetBytes: item.working,
    storageRequiredBytes: item.storage,
    confidence: "estimated",
  }));
}

export function modelsForMode<T extends { readonly id: string }>(
  models: readonly T[],
  mode: FitMode,
): readonly T[] {
  return mode === "beginner" ? models.slice(0, 3) : models;
}

function validResource(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}
