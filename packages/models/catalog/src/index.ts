import { z } from "zod";

export const CatalogFormatSchema = z.enum(["gguf", "mlx", "safetensors"]);
export const LicenseReferenceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url(),
    commercialUse: z.enum(["allowed", "restricted", "unknown"]),
  })
  .strict();
export const CatalogModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    publisher: z.string().min(1),
    description: z.string(),
    tags: z.array(z.string()),
    languages: z.array(z.string()),
    formats: z.array(CatalogFormatSchema).min(1),
    quants: z.array(z.string()),
    capabilities: z.record(z.string(), z.enum(["yes", "no", "unknown"])),
    license: LicenseReferenceSchema,
    source: z
      .object({ repository: z.string().min(1), revision: z.string().min(1) })
      .strict(),
    sizeBytes: z.number().int().positive().optional(),
    artifact: z
      .object({
        fileName: z.string().regex(/^[A-Za-z0-9._-]+\.gguf$/),
        url: z.string().url(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z.number().int().positive(),
        tier: z.enum(["faster", "balanced", "larger"]),
        contextWindow: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const ModelCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().min(1),
    models: z.array(CatalogModelSchema),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    catalog.models.forEach((model, index) => {
      if (ids.has(model.id))
        ctx.addIssue({
          code: "custom",
          path: ["models", index, "id"],
          message: "Duplicate model ID",
        });
      ids.add(model.id);
    });
  });
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

const phoneModels = [
  {
    size: "0.8B",
    tier: "faster",
    bytes: 532517120,
    revision: "6ab461498e2023f6e3c1baea90a8f0fe38ab64d0",
    sha256: "bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517",
    description:
      "Smallest download and the first choice for a quick offline reply.",
  },
  {
    size: "2B",
    tier: "balanced",
    bytes: 1280835840,
    revision: "f6d5376be1edb4d416d56da11e5397a961aca8ae",
    sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    description:
      "Suggested starting model for iPhone 17 Pro Max. Try this before moving to 4B.",
  },
  {
    size: "4B",
    tier: "larger",
    bytes: 2740937888,
    revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    description:
      "Larger option for more demanding replies; uses more memory and storage.",
  },
] as const;

/** Artifacts are pinned to the publisher revision and exact LFS digest. */
export const curatedCatalog: ModelCatalog = ModelCatalogSchema.parse({
  schemaVersion: 1,
  revision: "2026-09-27.2",
  models: [
    ...phoneModels.map((model) => {
      const repository = `unsloth/Qwen3.5-${model.size}-GGUF`;
      const fileName = `Qwen3.5-${model.size}-Q4_K_M.gguf`;
      return {
        id: `qwen/qwen3.5-${model.size.toLowerCase()}-q4_k_m`,
        name: `Qwen3.5 ${model.size} Q4_K_M`,
        publisher: "Qwen · GGUF by Unsloth",
        description: model.description,
        tags: ["chat", "offline", "iphone", model.tier],
        languages: ["en", "multilingual"],
        formats: ["gguf"],
        quants: ["Q4_K_M"],
        capabilities: { tools: "unknown", vision: "no", reasoning: "yes" },
        license: {
          id: "apache-2.0",
          name: "Apache License 2.0",
          url: "https://www.apache.org/licenses/LICENSE-2.0",
          commercialUse: "allowed",
        },
        source: { repository, revision: model.revision },
        sizeBytes: model.bytes,
        artifact: {
          fileName,
          url: `https://huggingface.co/${repository}/resolve/${model.revision}/${fileName}`,
          sha256: model.sha256,
          sizeBytes: model.bytes,
          tier: model.tier,
          contextWindow: 4096,
        },
      };
    }),
    {
      id: "meta-llama/llama-3.2-3b-instruct",
      name: "Llama 3.2 3B Instruct",
      publisher: "Meta",
      description: "Compact instruction model for local chat.",
      tags: ["chat", "small", "instruction"],
      languages: ["en"],
      formats: ["gguf", "mlx"],
      quants: ["Q4_K_M", "Q5_K_M", "Q8_0"],
      capabilities: { tools: "unknown", vision: "no", reasoning: "unknown" },
      license: {
        id: "llama-3.2",
        name: "Llama 3.2 Community License",
        url: "https://www.llama.com/llama3_2/license/",
        commercialUse: "restricted",
      },
      source: {
        repository: "meta-llama/Llama-3.2-3B-Instruct",
        revision: "main",
      },
    },
  ],
});

export function parseModelCatalog(input: unknown): ModelCatalog {
  return ModelCatalogSchema.parse(input);
}
export function searchCatalog(
  catalog: ModelCatalog,
  query: string,
  filters: {
    format?: z.infer<typeof CatalogFormatSchema>;
    quant?: string;
    capability?: string;
  } = {},
): readonly CatalogModel[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return catalog.models.filter((model) => {
    if (filters.format && !model.formats.includes(filters.format)) return false;
    if (
      filters.quant &&
      !model.quants.some(
        (quant) => quant.toLowerCase() === filters.quant!.toLowerCase(),
      )
    )
      return false;
    if (filters.capability && model.capabilities[filters.capability] !== "yes")
      return false;
    const haystack = [
      model.id,
      model.name,
      model.publisher,
      model.description,
      ...model.tags,
      ...model.languages,
      ...model.formats,
      ...model.quants,
      model.license.name,
    ]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
