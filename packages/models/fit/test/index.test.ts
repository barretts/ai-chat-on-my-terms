import { describe, expect, it } from "vitest";
import { recommendModelFits } from "../src/index.js";
import { curatedCatalog } from "@locallab/models-catalog";

const sized = curatedCatalog.models.map((model, index) => ({
  ...model,
  sizeBytes: (index + 1) * 500_000_000,
}));

describe("model fit guidance", () => {
  it("returns ordered conservative Faster, Balanced and Best choices within memory/storage budget", () => {
    const choices = recommendModelFits(
      sized,
      {
        availableMemoryBytes: 8_000_000_000,
        availableStorageBytes: 5_000_000_000,
        supportedFormats: ["gguf"],
      },
      "gguf",
    );
    expect(choices.map(({ tier }) => tier)).toEqual([
      "faster",
      "balanced",
      "best",
    ]);
    expect(
      choices.every(
        ({ estimatedWorkingSetBytes }) =>
          estimatedWorkingSetBytes <= 6_400_000_000,
      ),
    ).toBe(true);
  });

  it("does not recommend models when hardware, storage, or format facts are unknown/unsafe", () => {
    expect(
      recommendModelFits(
        sized,
        {
          availableMemoryBytes: null,
          availableStorageBytes: 4e9,
          supportedFormats: ["gguf"],
        },
        "gguf",
      ),
    ).toEqual([]);
    expect(
      recommendModelFits(
        sized,
        {
          availableMemoryBytes: 8e9,
          availableStorageBytes: 300_000_000,
          supportedFormats: ["gguf"],
        },
        "gguf",
      ),
    ).toEqual([]);
    expect(
      recommendModelFits(
        sized,
        {
          availableMemoryBytes: 8e9,
          availableStorageBytes: 4e9,
          supportedFormats: ["gguf"],
        },
        "mlx",
      ),
    ).toEqual([]);
  });
});
