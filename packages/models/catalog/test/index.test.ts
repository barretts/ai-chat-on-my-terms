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
      10,
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
  it("pins the LFM3 text, vision, and omni artifacts to publisher revisions and digests", () => {
    const pins = [
      {
        id: "liquid/lfm3-1.7b-q4_k_m",
        repository: "LiquidAI/LFM3-1.7B-GGUF",
        revision: "bad5729bba61d076fff20d2548e62526665af215",
        fileName: "LFM3-1.7B-Q4_K_M.gguf",
        sha256:
          "3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4",
        sizeBytes: 1099627808,
      },
      {
        id: "liquid/lfm3-vl-2b-q4_k_m",
        repository: "LiquidAI/LFM3-VL-2B-GGUF",
        revision: "b36554cfd35854b06429900131730cd80f092cdb",
        fileName: "LFM3-VL-2B-Q4_K_M.gguf",
        sha256:
          "56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb",
        sizeBytes: 1099627808,
      },
      {
        id: "liquid/lfm3-omni-2b-q4_k_m",
        repository: "LiquidAI/LFM3-Omni-2B-GGUF",
        revision: "2918dd47cfceb4f260cd1734cd1aac1b22bbe4b6",
        fileName: "LFM3-Omni-2B-Q4_K_M.gguf",
        sha256:
          "9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2",
        sizeBytes: 1099630080,
      },
    ];
    for (const pin of pins) {
      const model = curatedCatalog.models.find(
        (candidate) => candidate.id === pin.id,
      );
      expect(model, pin.id).toBeDefined();
      expect(model!.source, pin.id).toEqual({
        repository: pin.repository,
        revision: pin.revision,
      });
      expect(model!.artifact, pin.id).toEqual({
        fileName: pin.fileName,
        url: `https://huggingface.co/${pin.repository}/resolve/${pin.revision}/${pin.fileName}`,
        sha256: pin.sha256,
        sizeBytes: pin.sizeBytes,
        tier: "balanced",
        contextWindow: 4096,
      });
      expect(model!.license, pin.id).toMatchObject({
        id: "lfm-open-1.0",
        commercialUse: "restricted",
      });
    }
    expect(
      searchCatalog(curatedCatalog, "lfm3", { format: "gguf" })
        .map((model) => model.id)
        .sort(),
    ).toEqual([
      "liquid/lfm3-1.7b-q4_k_m",
      "liquid/lfm3-omni-2b-q4_k_m",
      "liquid/lfm3-vl-2b-q4_k_m",
    ]);
  });
});
