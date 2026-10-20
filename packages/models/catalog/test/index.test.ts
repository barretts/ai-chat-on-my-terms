import { describe, expect, it } from "vitest";
import {
  curatedCatalog,
  parseModelCatalog,
  searchCatalog,
} from "../src/index.js";

describe("versioned model catalog", () => {
  it("rejects malformed and duplicate manifest entries", () => {
    expect(() =>
      parseModelCatalog({ schemaVersion: 2, revision: "x", models: [] }),
    ).toThrow();
    expect(() =>
      parseModelCatalog({
        ...curatedCatalog,
        models: [curatedCatalog.models[0], curatedCatalog.models[0]],
      }),
    ).toThrow(/Duplicate/);
  });
  it("searches descriptions, quant labels, formats, and affirmative capabilities", () => {
    expect(
      searchCatalog(curatedCatalog, "llama compact", { format: "gguf" }).map(
        (model) => model.id,
      ),
    ).toEqual(["meta-llama/llama-3.2-3b-instruct"]);
    expect(searchCatalog(curatedCatalog, "", { quant: "q4_k_m" })).toHaveLength(
      7,
    );
    expect(
      searchCatalog(curatedCatalog, "", { capability: "tools" }),
    ).toHaveLength(0);
  });
  it("pins the Liquid LFM2.5 artifact to the publisher revision and digest", () => {
    const liquid = curatedCatalog.models.find(
      (model) => model.id === "liquid/lfm2.5-2.6b-q4_k_m",
    );
    expect(liquid).toBeDefined();
    expect(liquid!.source).toEqual({
      repository: "LiquidAI/LFM2.5-2.6B-GGUF",
      revision: "e7caca5d835a3901a8e0d63e94009429bafafdfc",
    });
    expect(liquid!.artifact).toEqual({
      fileName: "LFM2.5-2.6B-Q4_K_M.gguf",
      url: "https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/resolve/e7caca5d835a3901a8e0d63e94009429bafafdfc/LFM2.5-2.6B-Q4_K_M.gguf",
      sha256:
        "02a8b7e17487d326e46d68ce0ba24211e1b80a14c4cd0597fa73c1cd697f52ed",
      sizeBytes: 1674455040,
      tier: "balanced",
      contextWindow: 4096,
    });
    expect(liquid!.license).toMatchObject({
      id: "lfm-open-1.0",
      commercialUse: "restricted",
    });
    expect(
      searchCatalog(curatedCatalog, "liquid", { format: "gguf" }).map(
        (model) => model.id,
      ),
    ).toContain("liquid/lfm2.5-2.6b-q4_k_m");
  });
});
