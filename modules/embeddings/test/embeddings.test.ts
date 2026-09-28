import test from "node:test";
import assert from "node:assert/strict";
import {
  embeddingIdentity,
  selectLocalEmbeddingModel,
  validateEmbedding,
  type LocalEmbeddingRuntime,
} from "../src/index.js";

test("selects installed local model and identifies exact revision", () => {
  const remoteLike = {
    model: {
      id: "remote",
      dimensions: 2,
      local: false as true,
      installed: true,
      revision: "1",
    },
    embed: async () => [[1, 0]],
  } as unknown as LocalEmbeddingRuntime;
  const local: LocalEmbeddingRuntime = {
    model: {
      id: "tiny",
      dimensions: 2,
      local: true,
      installed: true,
      revision: "sha256:abc",
    },
    embed: async () => [[1, 0]],
  };
  assert.equal(selectLocalEmbeddingModel([remoteLike, local]), local);
  assert.equal(embeddingIdentity(local), "tiny@sha256:abc:2");
  assert.throws(() => validateEmbedding([Infinity, 0], 2));
});
