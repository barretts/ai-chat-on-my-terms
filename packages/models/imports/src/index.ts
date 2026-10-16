import { z } from "zod";
import type { CreateJobInput, JobStore } from "@locallab/jobs";
import {
  EntityIdSchema,
  RevisionSchema,
  type Revision,
} from "@locallab/contracts/identity";

export const ModelLifecycleSchema = z
  .object({
    modelId: z.string().min(1),
    imported: z.boolean(),
    downloaded: z.boolean(),
    selected: z.boolean(),
    loaded: z.boolean(),
    source: z.enum(["catalog", "gguf-import", "mlx-import", "huggingface"]),
    managedPath: z.string().optional(),
    jobId: z.string().optional(),
  })
  .strict();
export type ModelLifecycle = z.infer<typeof ModelLifecycleSchema>;

export interface ExternalModelFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly kind: "file" | "directory" | "symlink";
}
export interface ModelImportFileSystem {
  readPrefix(path: string, length: number): Promise<Uint8Array>;
  listTree(path: string): Promise<readonly ExternalModelFile[]>;
  /** Copies bytes into app managed storage; must never alter source. */
  copyIntoManaged(sourcePath: string, relativeTarget: string): Promise<void>;
}
export class ModelImportError extends Error {
  constructor(
    message: string,
    readonly code: "invalid-file" | "invalid-folder" | "unsafe-path" | "io",
  ) {
    super(message);
    this.name = "ModelImportError";
  }
}

export async function importGguf(
  fs: ModelImportFileSystem,
  sourcePath: string,
  modelId: string,
): Promise<ModelLifecycle> {
  validateModelId(modelId);
  if (!sourcePath.toLowerCase().endsWith(".gguf"))
    throw new ModelImportError("Expected a GGUF file", "invalid-file");
  const magic = await fs.readPrefix(sourcePath, 4);
  if (magic.length !== 4 || new TextDecoder().decode(magic) !== "GGUF")
    throw new ModelImportError("File does not have GGUF magic", "invalid-file");
  const destination = managedModelPath(modelId, "model.gguf");
  await fs.copyIntoManaged(sourcePath, destination);
  return {
    modelId,
    imported: true,
    downloaded: false,
    selected: false,
    loaded: false,
    source: "gguf-import",
    managedPath: destination,
  };
}

/** Validates a complete MLX model tree before copying any external file. */
export async function importMlxFolder(
  fs: ModelImportFileSystem,
  sourceDirectory: string,
  modelId: string,
): Promise<ModelLifecycle> {
  validateModelId(modelId);
  const entries = await fs.listTree(sourceDirectory);
  if (!entries.length)
    throw new ModelImportError("MLX folder is empty", "invalid-folder");
  let hasWeights = false;
  let hasConfig = false;
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = validateRelativePath(entry.path);
    if (entry.kind !== "file")
      throw new ModelImportError(
        "MLX folders cannot contain directories or symlinks in the file manifest",
        "invalid-folder",
      );
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0)
      throw new ModelImportError("Invalid MLX file size", "invalid-folder");
    if (seen.has(path))
      throw new ModelImportError("Duplicate MLX file path", "invalid-folder");
    seen.add(path);
    const lower = path.toLowerCase();
    if (/\.safetensors$/.test(lower)) hasWeights = true;
    if (lower === "config.json" || lower.endsWith("/config.json"))
      hasConfig = true;
  }
  if (!hasWeights || !hasConfig)
    throw new ModelImportError(
      "MLX folder needs config.json and at least one .safetensors weight file",
      "invalid-folder",
    );
  for (const entry of entries)
    await fs.copyIntoManaged(
      joinExternal(sourceDirectory, entry.path),
      managedModelPath(modelId, validateRelativePath(entry.path)),
    );
  return {
    modelId,
    imported: true,
    downloaded: false,
    selected: false,
    loaded: false,
    source: "mlx-import",
    managedPath: managedModelPath(modelId, ""),
  };
}

export interface HuggingFaceDownloadDescriptor {
  readonly repository: string;
  readonly revision: string;
  readonly file: string;
  readonly url: string;
  readonly credentialRef?: string;
  readonly expectedSha256?: string;
}
export const HuggingFaceDescriptorSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    revision: z.string().min(1).max(256),
    file: z.string().min(1),
    url: z.string().url(),
    credentialRef: z.string().min(1).optional(),
    expectedSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value.url);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "huggingface.co" ||
        url.username ||
        url.password
      )
        throw new Error();
      const expected =
        `/` +
        value.repository.split("/").map(encodeURIComponent).join("/") +
        `/resolve/${encodeURIComponent(value.revision)}/` +
        value.file.split("/").map(encodeURIComponent).join("/");
      if (url.pathname !== expected || !safeFile(value.file)) throw new Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "URL must be the matching HTTPS Hugging Face resolve URL",
      });
    }
  });
export function createHuggingFaceDescriptor(input: {
  repository: string;
  revision: string;
  file: string;
  credentialRef?: string;
  expectedSha256?: string;
}): HuggingFaceDownloadDescriptor {
  if (!safeFile(input.file))
    throw new ModelImportError("Unsafe Hugging Face file path", "unsafe-path");
  const url = `https://huggingface.co/${input.repository.split("/").map(encodeURIComponent).join("/")}/resolve/${encodeURIComponent(input.revision)}/${input.file.split("/").map(encodeURIComponent).join("/")}`;
  const parsed = HuggingFaceDescriptorSchema.parse({
    repository: input.repository,
    revision: input.revision,
    file: input.file,
    url,
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
  });
  return {
    repository: parsed.repository,
    revision: parsed.revision,
    file: parsed.file,
    url: parsed.url,
    ...(parsed.credentialRef === undefined
      ? {}
      : { credentialRef: parsed.credentialRef }),
    ...(parsed.expectedSha256 === undefined
      ? {}
      : { expectedSha256: parsed.expectedSha256 }),
  };
}
export function createHuggingFaceJob(
  descriptor: HuggingFaceDownloadDescriptor,
  idempotencyKey: string,
): CreateJobInput {
  const valid = HuggingFaceDescriptorSchema.parse(descriptor);
  if (!idempotencyKey.trim())
    throw new TypeError("Download idempotency key is required");
  // credentialRef is opaque. Resolve actual credentials only when a worker issues the request.
  return {
    kind: "model.huggingface.download",
    category: "download",
    idempotencyKey,
    input: valid,
  };
}

export class ModelLifecycleRegistry {
  private readonly entries = new Map<string, ModelLifecycle>();
  getAll(): readonly ModelLifecycle[] {
    return [...this.entries.values()].sort((a, b) =>
      a.modelId.localeCompare(b.modelId),
    );
  }
  get(modelId: string): ModelLifecycle | undefined {
    return this.entries.get(modelId);
  }
  set(input: ModelLifecycle): void {
    const value = ModelLifecycleSchema.parse(input);
    this.entries.set(value.modelId, value);
  }
  update(
    modelId: string,
    patch: Partial<Omit<ModelLifecycle, "modelId">>,
  ): ModelLifecycle {
    const prior = this.entries.get(modelId);
    if (!prior) throw new RangeError(`Unknown model: ${modelId}`);
    const next = ModelLifecycleSchema.parse({ ...prior, ...patch });
    this.entries.set(modelId, next);
    return next;
  }
  search(query: string): readonly ModelLifecycle[] {
    const terms = query
      .trim()
      .toLocaleLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter(Boolean);
    return this.getAll().filter((entry) => {
      const words = new Set(
        `${entry.modelId} ${entry.source} ${entry.imported ? "imported" : ""} ${entry.downloaded ? "downloaded" : ""} ${entry.selected ? "selected" : ""} ${entry.loaded ? "loaded" : ""}`
          .toLowerCase()
          .split(/[^a-z0-9.]+/)
          .filter(Boolean),
      );
      return terms.every((term) => words.has(term));
    });
  }
  async enqueueHuggingFace(
    jobs: JobStore,
    descriptor: HuggingFaceDownloadDescriptor,
    idempotencyKey: string,
    now: string,
    id: string,
    revision: Revision,
  ): Promise<ModelLifecycle> {
    const input = createHuggingFaceJob(descriptor, idempotencyKey);
    const result = await jobs.create(
      input,
      now,
      EntityIdSchema.parse(id),
      RevisionSchema.parse(revision),
    );
    const state = {
      modelId: descriptor.repository + "/" + descriptor.file,
      imported: false,
      downloaded: false,
      selected: false,
      loaded: false,
      source: "huggingface" as const,
      jobId: result.job.id,
    };
    this.set(state);
    return state;
  }
}

function validateModelId(id: string): void {
  if (
    !id.trim() ||
    id.length > 240 ||
    /[\\/\0\r\n]/.test(id) ||
    id === "." ||
    id === ".."
  )
    throw new TypeError("Invalid model ID");
}
function validateRelativePath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value)
  )
    throw new ModelImportError(
      "Unsafe path in MLX file manifest",
      "unsafe-path",
    );
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new ModelImportError(
      "Unsafe path in MLX file manifest",
      "unsafe-path",
    );
  return value;
}
function safeFile(value: string): boolean {
  try {
    validateRelativePath(value);
    return true;
  } catch {
    return false;
  }
}
function managedModelPath(modelId: string, relative: string): string {
  validateModelId(modelId);
  return `models/${encodeURIComponent(modelId)}/${relative}`;
}
function joinExternal(root: string, relative: string): string {
  if (!root || /[\0\r\n]/.test(root))
    throw new ModelImportError("Invalid source directory", "unsafe-path");
  return `${root.replace(/[\\/]+$/, "")}/${relative}`;
}
