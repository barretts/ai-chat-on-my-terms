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
      4,
    );
    expect(
      searchCatalog(curatedCatalog, "", { capability: "tools" }),
    ).toHaveLength(0);
  });
});
