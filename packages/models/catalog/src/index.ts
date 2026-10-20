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
  revision: "2026-10-20.1",
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
      id: "liquid/lfm2.5-2.6b-q4_k_m",
      name: "Liquid AI LFM2.5 2.6B Q4_K_M",
      publisher: "Liquid AI",
      description:
        "Responsive 2.6B alternative for group rounds; selectable, not the default. " +
        "Publisher sampling (temperature 0.1, top_k 50, penalty_repeat 1.1) rides " +
        "the model-scope defaults.",
      tags: ["chat", "offline", "iphone", "balanced"],
      languages: ["en", "multilingual"],
      formats: ["gguf"],
      quants: ["Q4_K_M"],
      capabilities: { tools: "unknown", vision: "no", reasoning: "unknown" },
      license: {
        id: "lfm-open-1.0",
        name: "LFM Open License v1.0",
        url: "https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/blob/e7caca5d835a3901a8e0d63e94009429bafafdfc/LICENSE",
        commercialUse: "restricted",
      },
      source: {
        repository: "LiquidAI/LFM2.5-2.6B-GGUF",
        revision: "e7caca5d835a3901a8e0d63e94009429bafafdfc",
      },
      sizeBytes: 1674455040,
      artifact: {
        fileName: "LFM2.5-2.6B-Q4_K_M.gguf",
        url: "https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/resolve/e7caca5d835a3901a8e0d63e94009429bafafdfc/LFM2.5-2.6B-Q4_K_M.gguf",
        sha256:
          "02a8b7e17487d326e46d68ce0ba24211e1b80a14c4cd0597fa73c1cd697f52ed",
        sizeBytes: 1674455040,
        tier: "balanced",
        contextWindow: 4096,
      },
    },
    {
      id: "hauhaucs/qwen3.5-2b-uncensored-aggressive-q4_k_m",
      name: "HauhauCS Qwen3.5 2B Aggressive Q4_K_M",
      publisher: "HauhauCS",
      description:
        "Uncensored conversational Qwen3.5; compact 1.27 GB download.",
      tags: ["chat", "offline", "iphone", "faster", "roleplay", "uncensored"],
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
      source: {
        repository: "HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive",
        revision: "2bcf35c1ebf62c837c12c1aa90b578ff4717e831",
      },
      sizeBytes: 1270808032,
      artifact: {
        fileName: "Qwen3.5-2B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf",
        url: "https://huggingface.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive/resolve/2bcf35c1ebf62c837c12c1aa90b578ff4717e831/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf",
        sha256:
          "be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517",
        sizeBytes: 1270808032,
        tier: "faster",
        contextWindow: 4096,
      },
    },
    {
      id: "minas2025/qwen3.5-0.8b-conversational-uncensored-q8_0",
      name: "Minas Qwen3.5 0.8B Conversational Uncensored Q8_0",
      publisher: "Minas2025",
      description:
        "Warm, conversational 0.8B fine-tune. Its training data has separate attribution and source-license notes.",
      tags: [
        "chat",
        "offline",
        "iphone",
        "faster",
        "conversation",
        "uncensored",
      ],
      languages: ["en"],
      formats: ["gguf"],
      quants: ["Q8_0"],
      capabilities: { tools: "unknown", vision: "no", reasoning: "unknown" },
      license: {
        id: "apache-2.0",
        name: "Apache License 2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0",
        commercialUse: "allowed",
      },
      source: {
        repository: "minas2025/Qwen-3.5-0.8B-Uncensored-Conversational",
        revision: "6523fb00954b107f38e6204478e63578332ad3e4",
      },
      sizeBytes: 811843264,
      artifact: {
        fileName: "Qwen-3.5-0.8B-Uncensored-Conversational-Q8.gguf",
        url: "https://huggingface.co/minas2025/Qwen-3.5-0.8B-Uncensored-Conversational/resolve/6523fb00954b107f38e6204478e63578332ad3e4/Qwen-3.5-0.8B-Uncensored-Conversational-Q8.gguf",
        sha256:
          "b9b4c476b74c1d915a00cfcb3156c88532287dd9c61d17e2731ccf71253c8a6b",
        sizeBytes: 811843264,
        tier: "faster",
        contextWindow: 2048,
      },
    },
    {
      id: "ermiaazarkhalili/qwen3.5-4b-sft-fable5-q5_k_m",
      name: "Qwen3.5 4B SFT Fable5 Q5_K_M",
      publisher: "Ermia Azarkhalili",
      description: "Story and conversational fine-tune of Qwen3.5 4B.",
      tags: ["chat", "offline", "iphone", "larger", "story", "roleplay"],
      languages: ["en"],
      formats: ["gguf"],
      quants: ["Q5_K_M"],
      capabilities: { tools: "unknown", vision: "no", reasoning: "unknown" },
      license: {
        id: "apache-2.0",
        name: "Apache License 2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0",
        commercialUse: "allowed",
      },
      source: {
        repository: "ermiaazarkhalili/Qwen3.5-4B-SFT-Fable5-GGUF",
        revision: "82b39e0ef7657ae28ec1eecc354aff96cef381b1",
      },
      sizeBytes: 3161425312,
      artifact: {
        fileName: "qwen3.5-4b-sft-fable5.q5_k_m.gguf",
        url: "https://huggingface.co/ermiaazarkhalili/Qwen3.5-4B-SFT-Fable5-GGUF/resolve/82b39e0ef7657ae28ec1eecc354aff96cef381b1/qwen3.5-4b-sft-fable5.q5_k_m.gguf",
        sha256:
          "118a2d8916dd82242cc8871e9047f66d6046263bbad066d6a97adbb3e7ad35ba",
        sizeBytes: 3161425312,
        tier: "larger",
        contextWindow: 4096,
      },
    },
    {
      id: "the-drummer/gemmasutra-small-4b-v1-q5_k_m",
      name: "Gemmasutra Small 4B v1 Q5_K_M",
      publisher: "TheDrummer",
      description:
        "Creative Gemma 2-based fine-tune for expressive chat and roleplay.",
      tags: ["chat", "offline", "iphone", "larger", "roleplay"],
      languages: ["en"],
      formats: ["gguf"],
      quants: ["Q5_K_M"],
      capabilities: { tools: "unknown", vision: "no", reasoning: "unknown" },
      license: {
        id: "unknown",
        name: "Publisher license metadata: other",
        url: "https://huggingface.co/TheDrummer/Gemmasutra-Small-4B-v1-GGUF",
        commercialUse: "unknown",
      },
      source: {
        repository: "TheDrummer/Gemmasutra-Small-4B-v1-GGUF",
        revision: "232cfe1143e5ee135bb68b4c2855b1de8f83efc9",
      },
      sizeBytes: 2805370752,
      artifact: {
        fileName: "Gemmasutra-Small-4B-v1a-Q5_K_M.gguf",
        url: "https://huggingface.co/TheDrummer/Gemmasutra-Small-4B-v1-GGUF/resolve/232cfe1143e5ee135bb68b4c2855b1de8f83efc9/Gemmasutra-Small-4B-v1a-Q5_K_M.gguf",
        sha256:
          "42d6f23bfb73856e7fedafdf26f157b46f5b6235f813d1b9ffe03ca3d71edd38",
        sizeBytes: 2805370752,
        tier: "larger",
        contextWindow: 4096,
      },
    },
    {
      id: "hauhaucs/gemma-4-e4b-uncensored-aggressive-q5_k_m",
      name: "HauhauCS Gemma 4 E4B Uncensored Q5_K_M",
      publisher: "HauhauCS",
      description: "Uncensored Gemma 4 E4B variant; large 5.76 GB download.",
      tags: ["chat", "offline", "iphone", "larger", "roleplay", "uncensored"],
      languages: ["en", "multilingual"],
      formats: ["gguf"],
      quants: ["Q5_K_M"],
      capabilities: {
        tools: "unknown",
        vision: "unknown",
        reasoning: "unknown",
      },
      license: {
        id: "gemma",
        name: "Gemma Terms of Use",
        url: "https://ai.google.dev/gemma/terms",
        commercialUse: "unknown",
      },
      source: {
        repository: "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
        revision: "45b6a334b4bcd1d7f37179df58b3b1d66a184e5d",
      },
      sizeBytes: 5762908128,
      artifact: {
        fileName: "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_M.gguf",
        url: "https://huggingface.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/resolve/45b6a334b4bcd1d7f37179df58b3b1d66a184e5d/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_M.gguf",
        sha256:
          "c96f1afc2af92bb27b1d5057fd91c8f6e41e9a72f9f32faa389e1601a6963ee6",
        sizeBytes: 5762908128,
        tier: "larger",
        contextWindow: 4096,
      },
    },
    {
      id: "tinman/gemma4-companion-q4_k_m",
      name: "Tinman Gemma 4 E4B Companion Q4_K_M",
      publisher: "Tinman Lab",
      description: "Companion and roleplay-oriented Gemma 4 E4B fine-tune.",
      tags: ["chat", "offline", "iphone", "larger", "companion", "roleplay"],
      languages: ["en"],
      formats: ["gguf"],
      quants: ["Q4_K_M"],
      capabilities: { tools: "unknown", vision: "no", reasoning: "unknown" },
      license: {
        id: "apache-2.0",
        name: "Apache License 2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0",
        commercialUse: "allowed",
      },
      source: {
        repository: "Tinman-Lab/Tinman-gemma4-companion-gguf",
        revision: "562285344d12b64e9017adbd72d3c6d927e98c7a",
      },
      sizeBytes: 5302272544,
      artifact: {
        fileName: "gemma4-companion-Q4_K_M.gguf",
        url: "https://huggingface.co/Tinman-Lab/Tinman-gemma4-companion-gguf/resolve/562285344d12b64e9017adbd72d3c6d927e98c7a/gemma4-companion-Q4_K_M.gguf",
        sha256:
          "c0498cd5f2089ca56cd55daca5f47716a44bafcb24afe1f6db207f7e5d8e39b2",
        sizeBytes: 5302272544,
        tier: "larger",
        contextWindow: 4096,
      },
    },
    {
      id: "minas2025/qwen3.5-4b-rp-finetune-q8_0",
      name: "Minas Qwen3.5 4B RP Fine-tune Q8_0",
      publisher: "Minas2025",
      description: "Roleplay-focused, uncensored Qwen3.5 4B fine-tune.",
      tags: ["chat", "offline", "iphone", "larger", "roleplay", "uncensored"],
      languages: ["en"],
      formats: ["gguf"],
      quants: ["Q8_0"],
      capabilities: { tools: "unknown", vision: "no", reasoning: "unknown" },
      license: {
        id: "unknown",
        name: "No license declared",
        url: "https://huggingface.co/minas2025/Qwen-3.5-4B-RP-Finetune",
        commercialUse: "unknown",
      },
      source: {
        repository: "minas2025/Qwen-3.5-4B-RP-Finetune",
        revision: "571939bc0ebf880a604468d619748f8645d44091",
      },
      sizeBytes: 4482402816,
      artifact: {
        fileName: "Qwen-3.5-4B-RP-Finetune-Q8.gguf",
        url: "https://huggingface.co/minas2025/Qwen-3.5-4B-RP-Finetune/resolve/571939bc0ebf880a604468d619748f8645d44091/Qwen-3.5-4B-RP-Finetune-Q8.gguf",
        sha256:
          "0b9fbe0d4f40fec8e97abaeb6add6381dd583ba7949fbf88847b8decbd3058fc",
        sizeBytes: 4482402816,
        tier: "larger",
        contextWindow: 4096,
      },
    },
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
