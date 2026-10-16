import { describe, expect, it } from "vitest";
import { MemoryJobStore } from "@locallab/jobs/memory-store";
import {
  createHuggingFaceDescriptor,
  createHuggingFaceJob,
  importGguf,
  importMlxFolder,
  ModelImportError,
  ModelLifecycleRegistry,
} from "../src/index.js";

const fakeFs = (
  entries: readonly {
    path: string;
    sizeBytes: number;
    kind: "file" | "directory" | "symlink";
  }[] = [],
  magic = "GGUF",
) => {
  const copied: string[] = [];
  return {
    copied,
    fs: {
      async readPrefix() {
        return new TextEncoder().encode(magic);
      },
      async listTree() {
        return entries;
      },
      async copyIntoManaged(src: string, dest: string) {
        copied.push(`${src}->${dest}`);
      },
    },
  };
};

describe("model imports and lifecycle", () => {
  it("copies valid GGUF data and leaves the source path untouched", async () => {
    const { fs, copied } = fakeFs();
    const state = await importGguf(fs, "/external/model.gguf", "repo-model");
    expect(state.imported).toBe(true);
    expect(state.downloaded).toBe(false);
    expect(copied).toEqual([
      "/external/model.gguf->models/repo-model/model.gguf",
    ]);
  });
  it("rejects bad GGUF and unsafe/incomplete MLX manifests before copying", async () => {
    const badGguf = fakeFs([], "NOPE");
    await expect(
      importGguf(badGguf.fs, "/external/m.gguf", "m"),
    ).rejects.toBeInstanceOf(ModelImportError);
    const traversal = fakeFs([
      { path: "../escape.safetensors", sizeBytes: 9, kind: "file" },
    ]);
    await expect(
      importMlxFolder(traversal.fs, "/external/mlx", "m"),
    ).rejects.toThrow(/Unsafe path/);
    expect(traversal.copied).toHaveLength(0);
    const incomplete = fakeFs([
      { path: "config.json", sizeBytes: 10, kind: "file" },
    ]);
    await expect(
      importMlxFolder(incomplete.fs, "/external/mlx", "m"),
    ).rejects.toThrow(/safetensors/);
  });
  it("validates MLX config, weights and file-only manifest", async () => {
    const { fs, copied } = fakeFs([
      { path: "config.json", sizeBytes: 100, kind: "file" },
      { path: "weights/model.safetensors", sizeBytes: 1000, kind: "file" },
    ]);
    const state = await importMlxFolder(fs, "/external/mlx", "mlx-model");
    expect(state.source).toBe("mlx-import");
    expect(copied).toHaveLength(2);
  });
  it("creates safe HF descriptors/jobs without embedding a secret and tracks searchable states", () => {
    const descriptor = createHuggingFaceDescriptor({
      repository: "owner/model",
      revision: "main",
      file: "model.gguf",
      credentialRef: "secret-ref",
    });
    expect(descriptor.url).toBe(
      "https://huggingface.co/owner/model/resolve/main/model.gguf",
    );
    expect(
      JSON.stringify(createHuggingFaceJob(descriptor, "download-1")),
    ).not.toContain("token");
    expect(() =>
      createHuggingFaceDescriptor({
        repository: "owner/model",
        revision: "main",
        file: "../secret",
      }),
    ).toThrow();
    const registry = new ModelLifecycleRegistry();
    registry.set({
      modelId: "owner/model",
      imported: false,
      downloaded: false,
      selected: false,
      loaded: false,
      source: "huggingface",
      jobId: "job-1",
    });
    registry.update("owner/model", { downloaded: true });
    expect(registry.search("downloaded")).toHaveLength(1);
    expect(registry.search("loaded")).toHaveLength(0);
  });
  it("enqueues a Hugging Face job with a correctly typed entity revision (R012)", async () => {
    const registry = new ModelLifecycleRegistry();
    const descriptor = createHuggingFaceDescriptor({
      repository: "owner/model",
      revision: "main",
      file: "model.gguf",
    });
    const revision = {
      wallMs: 1_750_000_000_000,
      counter: 0,
      deviceId: "018f0b1a-7b3c-7abc-8def-123456789abc",
    };
    const jobs = new MemoryJobStore();
    const state = await registry.enqueueHuggingFace(
      jobs,
      descriptor,
      "download-1",
      "2026-01-01T00:00:00.000Z",
      "018f0b1a-7b3c-7abc-8def-123456789abd",
      revision,
    );
    expect(state).toEqual({
      modelId: "owner/model/model.gguf",
      imported: false,
      downloaded: false,
      selected: false,
      loaded: false,
      source: "huggingface",
      jobId: "018f0b1a-7b3c-7abc-8def-123456789abd",
    });
    expect((await jobs.get(state.jobId ?? ""))?.revision).toEqual(revision);
    const partial = new MemoryJobStore();
    await expect(
      registry.enqueueHuggingFace(
        partial,
        descriptor,
        "download-2",
        "2026-01-01T00:00:00.000Z",
        "018f0b1a-7b3c-7abc-8def-123456789abe",
        { wallMs: -5, counter: 0, deviceId: "not-an-id" } as never,
      ),
    ).rejects.toThrow();
    expect(await partial.listAll()).toHaveLength(0);
  });
});
