import { expect, it } from "vitest";
import { WhisperTranscriber } from "./core";
import type { AsrEngine, ModelFs, PcmCapture } from "./core";
import type { WhisperModel } from "./catalog";
import { whisperModels } from "./catalog";

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

interface Harness {
  files: Map<string, number>;
  downloads: string[];
  fs: ModelFs;
  setDiskBytes(bytes: number): void;
}

function fakeFs(options: { diskBytes?: number } = {}): Harness {
  const files = new Map<string, number>();
  const downloads: string[] = [];
  let diskBytes = options.diskBytes ?? 8 * 1024 * 1024 * 1024;
  const fs: ModelFs = {
    async exists(path) {
      return files.has(path);
    },
    async readJson(path) {
      const raw = files.get(path);
      if (raw === undefined) throw new Error(`missing ${path}`);
      return JSON.parse(storedJson.get(path) ?? "{}");
    },
    async writeJson(path, value) {
      storedJson.set(path, JSON.stringify(value));
      files.set(path, 1);
    },
    async ensureDir() {},
    async removeTree(path) {
      for (const key of [...files.keys()])
        if (key.startsWith(path)) files.delete(key);
      for (const key of [...storedJson.keys()])
        if (key.startsWith(path)) storedJson.delete(key);
    },
    async fileSize(path) {
      return files.get(path) ?? 0;
    },
    async download(url, destination, onProgress, signal) {
      downloads.push(url);
      const expected = corruptSizes.get(url);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new AbortError());
        if (signal.aborted) return reject(new AbortError());
        signal.addEventListener("once", onAbort);
        queueMicrotask(() => {
          signal.removeEventListener("once", onAbort);
          resolve();
        });
      });
      const size = expected ?? sizeByUrl.get(url);
      if (size === undefined) throw new Error(`unknown url ${url}`);
      files.set(destination, size);
      onProgress(size, size);
      return size;
    },
    availableDiskBytes() {
      return diskBytes;
    },
  };
  return {
    files,
    downloads,
    fs,
    setDiskBytes(bytes: number) {
      diskBytes = bytes;
    },
  };
}

const storedJson = new Map<string, string>();
const sizeByUrl = new Map<string, number>();
const corruptSizes = new Map<string, number>();
for (const model of whisperModels)
  for (const file of model.files) sizeByUrl.set(file.url, file.bytes);

class FakeEngine implements AsrEngine {
  inits: { modelDir: string; language: string }[] = [];
  releases = 0;
  fileText = " transcript text ";
  sampleText = "live text";
  initFails = false;
  recognizeFails = false;
  async initAsr(config: {
    modelDir: string;
    language: string;
  }): Promise<{ success: boolean; error?: string }> {
    this.inits.push({ modelDir: config.modelDir, language: config.language });
    return this.initFails
      ? { success: false, error: "out of memory" }
      : { success: true };
  }
  async recognizeFromFile(): Promise<{
    success: boolean;
    text?: string;
    error?: string;
  }> {
    return this.recognizeFails
      ? { success: false, error: "bad file" }
      : { success: true, text: this.fileText };
  }
  async recognizeFromSamples(): Promise<{
    success: boolean;
    text?: string;
    error?: string;
  }> {
    return this.recognizeFails
      ? { success: false, error: "bad audio" }
      : { success: true, text: this.sampleText };
  }
  async releaseAsr(): Promise<{ released: boolean }> {
    this.releases += 1;
    return { released: true };
  }
}

class FakeCapture implements PcmCapture {
  granted = true;
  started: number[] = [];
  stops = 0;
  cancels = 0;
  audio = { sampleRate: 16000, samples: [0.1, 0.2, 0.3] };
  async requestPermission(): Promise<boolean> {
    return this.granted;
  }
  async start(sampleRate: number): Promise<void> {
    this.started.push(sampleRate);
  }
  async stop(): Promise<{ sampleRate: number; samples: number[] }> {
    this.stops += 1;
    return this.audio;
  }
  async cancel(): Promise<void> {
    this.cancels += 1;
  }
}

const root = "file:///models/";

function harness(capture: FakeCapture = new FakeCapture()) {
  const engine = new FakeEngine();
  const h = fakeFs();
  const whisper = new WhisperTranscriber({
    root,
    fs: h.fs,
    engine: async () => engine,
    capture,
  });
  return { whisper, engine, capture, fsHarness: h };
}

function model(id: string): WhisperModel {
  return whisperModels.find((item) => item.id === id)!;
}

it("installs every model file and marks the directory ready", async () => {
  const { whisper, fsHarness } = harness();
  await whisper.refresh();
  expect(whisper.snapshot().installedModelIds).toEqual([]);
  await whisper.install("whisper-tiny");
  const tiny = model("whisper-tiny");
  expect(fsHarness.downloads).toEqual(tiny.files.map((file) => file.url));
  expect(whisper.snapshot().installedModelIds).toContain("whisper-tiny");
  expect(whisper.snapshot().phase).toBe("idle");
  const marker = JSON.parse(
    storedJson.get(`${root}${tiny.directory}/ready.json`)!,
  );
  expect(marker).toMatchObject({
    modelId: "whisper-tiny",
    totalBytes: tiny.totalBytes,
    verification: "size-only",
  });
});

it("skips complete files on retry", async () => {
  const { whisper, fsHarness } = harness();
  const tiny = model("whisper-tiny");
  fsHarness.files.set(
    `${root}${tiny.directory}/${tiny.files[0].name}`,
    tiny.files[0].bytes,
  );
  await whisper.install("whisper-tiny");
  expect(fsHarness.downloads).toEqual(tiny.files.slice(1).map((f) => f.url));
});

it("gates installs that cannot fit on disk", async () => {
  const { whisper, fsHarness } = harness();
  fsHarness.setDiskBytes(
    model("whisper-large-v3").requiredFreeBytes - 1,
  );
  await whisper.install("whisper-large-v3");
  expect(whisper.snapshot().phase).toBe("error");
  expect(whisper.snapshot().message).toContain("MB free");
  expect(whisper.snapshot().message).toContain("smaller model");
});

it("fails honestly when a download has the wrong size", async () => {
  const { whisper } = harness();
  const tiny = model("whisper-tiny");
  corruptSizes.set(tiny.files[1].url, tiny.files[1].bytes - 1);
  await whisper.install("whisper-tiny");
  expect(whisper.snapshot().phase).toBe("error");
  expect(whisper.snapshot().message).toContain("wrong size");
  expect(whisper.snapshot().installedModelIds).toEqual([]);
  corruptSizes.clear();
});

it("cancels an in-flight install without failing", async () => {
  const { whisper } = harness();
  const installing = whisper.install("whisper-small");
  whisper.cancelInstall();
  await installing;
  expect(whisper.snapshot().phase).toBe("idle");
  expect(whisper.snapshot().message).toContain("canceled");
});

it("transcribes files only after installing the selected model", async () => {
  const { whisper, engine } = harness();
  await whisper.refresh();
  await expect(whisper.transcribeFile("file:///a.m4a")).rejects.toThrow(
    "Download a Whisper model before transcribing files.",
  );
  await whisper.install("whisper-tiny");
  await whisper.setLanguage("de");
  const text = await whisper.transcribeFile("file:///a.m4a");
  expect(text).toBe("transcript text");
  expect(engine.inits).toEqual([
    {
      modelDir: `${root}${model("whisper-tiny").directory}/`,
      language: "de",
    },
  ]);
  // Second call reuses the loaded engine.
  await whisper.transcribeFile("file:///b.m4a");
  expect(engine.inits).toHaveLength(1);
});

it("listens, stops, and recognizes the captured PCM", async () => {
  const capture = new FakeCapture();
  const { whisper, engine } = harness(capture);
  await whisper.install("whisper-tiny");
  const controller = new AbortController();
  const { outcome, handle } = await whisper.listen(controller.signal);
  handle.stop();
  const result = await outcome;
  expect(result).toEqual({ ok: true, text: "live text" });
  expect(capture.started).toEqual([16000]);
  expect(capture.stops).toBe(1);
  expect(engine.inits[0].language).toBe("");
});

it("cancels live capture without recognizing", async () => {
  const capture = new FakeCapture();
  const { whisper, engine } = harness(capture);
  await whisper.install("whisper-tiny");
  const controller = new AbortController();
  const { outcome } = await whisper.listen(controller.signal);
  controller.abort();
  expect(await outcome).toMatchObject({ ok: false, code: "canceled" });
  expect(capture.cancels).toBe(1);
  expect(capture.stops).toBe(0);
  expect(engine.inits).toEqual([]);
});

it("reports missing microphone permission through the outcome", async () => {
  const capture = new FakeCapture();
  capture.granted = false;
  const { whisper } = harness(capture);
  await whisper.install("whisper-tiny");
  const { outcome } = await whisper.listen(new AbortController().signal);
  expect(await outcome).toMatchObject({ ok: false, code: "permission" });
  expect(capture.started).toEqual([]);
});

it("reinitializes the engine when the language hint changes", async () => {
  const { whisper, engine } = harness();
  await whisper.install("whisper-tiny");
  await whisper.transcribeFile("file:///a.m4a");
  whisper.setLanguage("fr");
  await whisper.transcribeFile("file:///b.m4a");
  expect(engine.inits.map((init) => init.language)).toEqual(["", "fr"]);
  expect(engine.releases).toBe(1);
  expect(() => whisper.setLanguage("klingon")).toThrow(
    "Choose a supported language.",
  );
});
