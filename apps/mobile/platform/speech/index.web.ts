import { unzipSync } from "fflate";
import { httpResponseError } from "@locallab/network-http";
import { speechModel, speechModels, speechText, speechVoice } from "./catalog";
import { SpeechStateStore, speechFailureDetails, speechRate } from "./state";
import type { OfflineSpeech } from "./types";
export { speechLanguages, speechModels, speechVoices } from "./catalog";
export type { OfflineSpeech, SpeechState } from "./types";

const cacheName = "locallab-offline-speech-v1-wasm-1.3.1";
const selectionKey = "locallab.offlineSpeech.voice";
const runtimeFiles = [
  "worker.js",
  "runtime/sherpa-onnx-wasm-combined.js",
  "runtime/sherpa-onnx-wasm-combined.wasm",
];
type Manifest = {
  workerRevision?: number;
  files: { name: string; bytes: number; sha256?: string }[];
};
type WorkerReply = {
  id: number;
  error?: string;
  samples?: Float32Array<ArrayBuffer>;
  sampleRate?: number;
  numSpeakers?: number;
};
async function verify(
  bytes: ArrayBuffer,
  file: Manifest["files"][number],
  runtime = false,
) {
  if (bytes.byteLength !== file.bytes)
    throw new Error(
      `Incomplete offline speech file: ${file.name}. Received ${bytes.byteLength} bytes; expected ${file.bytes}. Remove and download the model again.`,
    );
  if (!runtime) return;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (
    Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("") !==
    file.sha256
  )
    throw new Error(
      `Offline speech integrity check failed: ${file.name}. Remove and download the model again.`,
    );
}

class BrowserSpeech extends SpeechStateStore implements OfflineSpeech {
  private worker: Worker | null = null;
  private workerUrls: string[] = [];
  private pending = new Map<
    number,
    { resolve: (value: WorkerReply) => void; reject: (error: Error) => void }
  >();
  private sequence = 0;
  private loadedModel: string | null = null;
  private controller: AbortController | null = null;
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private finishPlayback: (() => void) | null = null;
  private generation = 0;
  private admission = 0;

  async refresh() {
    const rate = Number(localStorage.getItem(`${selectionKey}.rate`) ?? 1);
    if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2)
      this.update({ rate });
    const saved = localStorage.getItem(selectionKey);
    if (saved) {
      try {
        speechVoice(saved);
        this.update({ selectedVoiceId: saved });
      } catch {
        /* Ignore obsolete selection. */
      }
    }
    const cache = await caches.open(cacheName);
    const installed: string[] = [];
    for (const model of speechModels) {
      const marker = await cache.match(
        `/speech/models/${model.id}/manifest.json`,
      );
      if (!marker) continue;
      const manifest = (await marker.json()) as Manifest;
      if (
        (
          await Promise.all(
            manifest.files.map((file) =>
              cache.match(`/speech/models/${model.id}/${file.name}`),
            ),
          )
        ).every(Boolean)
      )
        installed.push(model.id);
    }
    this.update({ installedModelIds: installed });
  }
  async selectVoice(id: string) {
    speechVoice(id);
    const admission = ++this.admission;
    await this.stop(false);
    if (admission !== this.admission) return;
    localStorage.setItem(selectionKey, id);
    this.update({
      selectedVoiceId: id,
      message: `${speechVoice(id).name} selected.`,
    });
  }
  async install(id: string) {
    const model = speechModel(id);
    const admission = ++this.admission;
    await this.stop(false);
    if (admission !== this.admission) return;
    const controller = new AbortController();
    this.controller = controller;
    this.update({
      phase: "downloading",
      message: `Downloading ${model.name} for offline use…`,
      progress: 0,
    });
    try {
      const cache = await caches.open(cacheName);
      const manifestResponse = await fetch(
        `/speech/models/${id}/manifest.json`,
        { signal: controller.signal },
      );
      if (!manifestResponse.ok)
        throw await httpResponseError(manifestResponse, {
          summary:
            "The voice-pack manifest request failed. Ask the preview host owner to prepare offline speech assets, then retry.",
          signal: controller.signal,
        });
      const manifest = (await manifestResponse.clone().json()) as Manifest;
      if (
        !manifest.files?.length ||
        manifest.files.some(
          (file) =>
            !/^[a-zA-Z0-9_.-]+$/.test(file.name) ||
            file.bytes <= 0 ||
            file.bytes > 400_000_000,
        )
      )
        throw new Error(
          "The offline voice-pack manifest contains no usable files or invalid file names/sizes.",
        );
      const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
      if (total > 500_000_000)
        throw new Error(
          `The offline voice pack contains ${total} bytes, exceeding this browser's 500000000-byte download limit.`,
        );
      let completed = 0;
      await this.cacheRuntime(cache, controller.signal);
      for (const file of manifest.files) {
        const url = `/speech/models/${id}/${file.name}`;
        const existing = await cache.match(url);
        if (!existing) {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok)
            throw await httpResponseError(response, {
              summary: `Voice file ${file.name} could not download.`,
              signal: controller.signal,
            });
          if (!response.body)
            throw new Error("The browser cannot stream this voice download.");
          const reader = response.body.getReader();
          let received = 0;
          let lastProgressAt = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull: async (target) => {
              try {
                controller.signal.throwIfAborted();
                const chunk = await reader.read();
                if (chunk.done) {
                  if (received !== file.bytes)
                    throw new Error(
                      `Incomplete voice file ${file.name}: received ${received} bytes; expected ${file.bytes}.`,
                    );
                  target.close();
                  return;
                }
                received += chunk.value.byteLength;
                if (received > file.bytes)
                  throw new Error(
                    `Voice file ${file.name} received ${received} bytes, exceeding its expected ${file.bytes} bytes.`,
                  );
                const now = performance.now();
                if (
                  admission === this.admission &&
                  (now - lastProgressAt >= 250 || received === file.bytes)
                ) {
                  this.update({ progress: (completed + received) / total });
                  lastProgressAt = now;
                }
                target.enqueue(chunk.value);
              } catch (error) {
                target.error(error);
                await reader.cancel(error).catch(() => undefined);
              }
            },
            cancel: (reason) => reader.cancel(reason),
          });
          try {
            await cache.put(url, new Response(stream));
          } catch (error) {
            try {
              await cache.delete(url);
            } catch (cleanup) {
              throw new Error(
                `Removing the incomplete voice file from browser storage also failed: ${speechFailureDetails(cleanup)}`,
                { cause: error },
              );
            }
            throw error;
          }
        } else await verify(await existing.arrayBuffer(), file);
        completed += file.bytes;
        if (admission === this.admission)
          this.update({ progress: completed / total });
      }
      controller.signal.throwIfAborted();
      await cache.put(`/speech/models/${id}/manifest.json`, manifestResponse);
      await this.refresh();
      if (admission === this.admission)
        this.update({
          phase: "idle",
          progress: null,
          message: `${model.name} saved in this browser. Speech synthesis needs no internet connection.`,
        });
    } catch (error) {
      if (controller.signal.aborted) {
        if (admission === this.admission)
          this.update({
            phase: "idle",
            progress: null,
            message: "Download stopped. You can resume it.",
          });
      } else {
        this.fail(error);
        throw error;
      }
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
  async setRate(rate: number) {
    speechRate(rate);
    await this.stop();
    localStorage.setItem(`${selectionKey}.rate`, String(rate));
    this.update({ rate, message: `Voice speed saved: ${rate}×.` });
  }
  private async cacheRuntime(cache: Cache, signal?: AbortSignal) {
    const response = await fetch("/speech/runtime/source.json", {
      signal: signal ?? null,
    });
    if (!response.ok)
      throw await httpResponseError(response, {
        summary:
          "The offline voice runtime manifest request failed. The voice tools are unavailable on this preview host.",
        ...(signal ? { signal } : {}),
      });
    const manifest = (await response.clone().json()) as Manifest & {
      version: string;
      sherpaOnnxVersion: string;
    };
    if (
      manifest.version !== "1.3.1" ||
      manifest.sherpaOnnxVersion !== "1.13.0" ||
      manifest.workerRevision !== 2 ||
      manifest.files.length !== runtimeFiles.length ||
      new Set(manifest.files.map((file) => file.name)).size !==
        runtimeFiles.length ||
      manifest.files.some(
        (file) =>
          !runtimeFiles.includes(file.name) ||
          !Number.isSafeInteger(file.bytes) ||
          file.bytes <= 0 ||
          file.bytes > 20_000_000 ||
          !/^[\da-f]{64}$/i.test(file.sha256 ?? ""),
      )
    )
      throw new Error(
        "The offline voice runtime manifest has an unsupported version, missing files, or invalid file sizes/checksums.",
      );
    for (const file of manifest.files) {
      const url = `/speech/${file.name}`;
      let saved = await cache.match(url);
      let cachedFailure: unknown;
      if (saved) {
        try {
          await verify(await saved.clone().arrayBuffer(), file, true);
        } catch (cause) {
          cachedFailure = cause;
          saved = undefined;
        }
      }
      if (!saved) {
        const downloaded = await fetch(url, { signal: signal ?? null });
        if (!downloaded.ok)
          throw new Error(
            `Offline voice runtime file ${file.name} could not download.\n${(await httpResponseError(downloaded, signal ? { signal } : {})).message}`,
            { cause: cachedFailure },
          );
        const bytes = await downloaded.arrayBuffer();
        await verify(bytes, file, true);
        signal?.throwIfAborted();
        await cache.put(url, new Response(bytes));
      }
    }
    signal?.throwIfAborted();
    await cache.put("/speech/runtime/source.json", response);
  }
  async repairRuntime() {
    const admission = ++this.admission;
    await this.stop(false);
    if (admission !== this.admission) return;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error("Voice repair timed out. Check your connection and retry."),
        ),
      30000,
    );
    this.update({
      phase: "loading",
      progress: null,
      message: "Repairing offline voices. Your voice packs are kept…",
    });
    try {
      await this.cacheRuntime(await caches.open(cacheName), controller.signal);
      if (admission === this.admission)
        this.update({
          phase: "idle",
          message:
            "Offline voices repaired. Your voice packs are ready to use.",
        });
    } catch (error) {
      if (admission === this.admission) this.fail(error);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }
  async remove(id: string) {
    speechModel(id);
    const admission = ++this.admission;
    await this.stop(false);
    if (admission !== this.admission) return;
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys())
      if (new URL(request.url).pathname.startsWith(`/speech/models/${id}/`))
        await cache.delete(request);
    await this.refresh();
    this.update({ message: "Offline voice model removed." });
  }
  private call(
    message: Record<string, unknown>,
    transfer: Transferable[] = [],
  ) {
    const id = ++this.sequence;
    return new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...message, id }, transfer);
    });
  }
  private async load(id: string, generation: number) {
    if (this.loadedModel === id && this.worker) return;
    const model = speechModel(id);
    const cache = await caches.open(cacheName);
    const cached = async (path: string) => {
      const response = await cache.match(path);
      if (!response)
        throw new Error("Download this voice model before reading aloud.");
      return response;
    };
    const manifest = (await (
      await cached(`/speech/models/${id}/manifest.json`)
    ).json()) as Manifest;
    let runtimeManifest = (await (
      await cached("/speech/runtime/source.json")
    ).json()) as Manifest;
    if (runtimeManifest.workerRevision !== 2) {
      if (!navigator.onLine)
        throw new Error(
          "Connect once and choose Repair offline voices to enable the new voice controls. Your voice packs are kept.",
        );
      const controller = new AbortController();
      this.controller = controller;
      try {
        await this.cacheRuntime(cache, controller.signal);
      } finally {
        if (this.controller === controller) this.controller = null;
      }
      if (generation !== this.generation) throw new Error("Speech stopped.");
      runtimeManifest = (await (
        await cached("/speech/runtime/source.json")
      ).json()) as Manifest;
    }
    const urls: string[] = [];
    const runtimeBytes = async (name: string) => {
      const bytes = await (await cached(`/speech/${name}`)).arrayBuffer();
      const file = runtimeManifest.files.find((item) => item.name === name);
      if (!file)
        throw new Error(
          "Incomplete offline speech runtime. Remove and download the model again.",
        );
      await verify(bytes, file, true);
      if (generation !== this.generation) throw new Error("Speech stopped.");
      return bytes;
    };
    const blobUrl = async (name: string, type: string) => {
      const bytes = await runtimeBytes(name);
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      urls.push(url);
      return url;
    };
    try {
      const runtime = {
        glue: await blobUrl(runtimeFiles[1]!, "application/javascript"),
        wasm: await runtimeBytes(runtimeFiles[2]!),
      };
      const workerUrl = await blobUrl("worker.js", "application/javascript");
      const files: { name: string; bytes: ArrayBuffer }[] = [];
      for (const file of manifest.files) {
        const bytes = await (
          await cached(`/speech/models/${id}/${file.name}`)
        ).arrayBuffer();
        await verify(bytes, file);
        if (file.name === "espeak-ng-data.zip") {
          for (const [entryName, data] of Object.entries(
            unzipSync(new Uint8Array(bytes)),
          )) {
            const name = entryName.replace(/\\/g, "/");
            if (name.endsWith("/")) continue;
            if (
              !name.startsWith("espeak-ng-data/") ||
              name.includes("..") ||
              name.startsWith("/")
            )
              throw new Error("Invalid pronunciation data archive.");
            files.push({ name, bytes: data.slice().buffer });
          }
        } else if (!file.name.includes("LICENSE") && file.name !== "MODEL_CARD")
          files.push({ name: file.name, bytes });
      }
      if (generation !== this.generation) throw new Error("Speech stopped.");
      this.workerUrls = urls;
      this.worker = new Worker(workerUrl);
      this.worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
        const task = this.pending.get(data.id);
        if (!task) return;
        this.pending.delete(data.id);
        data.error ? task.reject(new Error(data.error)) : task.resolve(data);
      };
      this.worker.onerror = (event) => {
        for (const task of this.pending.values())
          task.reject(
            new Error(event.message || "Offline speech worker failed."),
          );
        this.pending.clear();
      };
      await this.call({ kind: "load", type: model.type, runtime, files }, [
        ...files.map((file) => file.bytes),
        runtime.wasm,
      ]);
      this.loadedModel = id;
    } finally {
      if (generation !== this.generation)
        for (const url of urls) URL.revokeObjectURL(url);
    }
  }
  async speak(
    text: string,
    id = this.state.selectedVoiceId,
    rate = this.state.rate,
  ) {
    const admission = ++this.admission;
    await this.stop(false);
    if (admission !== this.admission) return;
    const generation = this.generation;
    try {
      const clean = speechText(text);
      speechRate(rate);
      const voice = speechVoice(id);
      this.context = new AudioContext();
      await this.context.resume();
      if (this.context.state !== "running")
        throw new Error(
          "Allow audio playback in this browser, then tap Read aloud again.",
        );
      this.update({
        phase: "loading",
        progress: null,
        message: `Loading ${voice.name} locally…`,
      });
      await this.load(voice.modelId, generation);
      if (generation !== this.generation) return;
      this.update({
        phase: "generating",
        message: `Generating ${voice.name} audio on this device…`,
      });
      const reply = await this.call({
        kind: "generate",
        text: clean,
        speakerId: voice.speakerId,
        speed: rate,
      });
      if (generation !== this.generation) return;
      const samples = reply.samples!;
      const sampleRate = reply.sampleRate!;
      if (!samples?.length || !sampleRate)
        throw new Error("Offline voice returned no audio.");
      const context = this.context!;
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      this.source = source;
      const audioUri = URL.createObjectURL(wav(samples, sampleRate));
      if (this.state.audioUri) URL.revokeObjectURL(this.state.audioUri);
      this.update({
        phase: "playing",
        audioUri,
        message: `${voice.name} · ${(samples.length / sampleRate).toFixed(1)} seconds · Generated offline`,
      });
      await new Promise<void>((resolve) => {
        this.finishPlayback = resolve;
        source.onended = () => resolve();
        source.start();
      });
      if (generation === this.generation) this.finishPlayback = null;
      if (generation === this.generation)
        this.update({
          phase: "idle",
          message: `${voice.name} finished reading aloud. Audio generated offline.`,
        });
      if (this.context === context) {
        this.context = null;
        this.source = null;
        await context.close();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      let failure = error;
      try {
        await this.releaseWorker();
        if (this.context) await this.context.close();
      } catch (cleanup) {
        failure = new Error(
          `Browser playback cleanup also failed: ${speechFailureDetails(cleanup)}`,
          { cause: error },
        );
      } finally {
        this.context = null;
        this.source = null;
      }
      this.fail(failure);
      throw failure;
    }
  }
  private async releaseWorker() {
    this.worker?.terminate();
    this.worker = null;
    this.loadedModel = null;
    for (const task of this.pending.values())
      task.reject(new Error("Speech stopped."));
    this.pending.clear();
    for (const url of this.workerUrls) URL.revokeObjectURL(url);
    this.workerUrls = [];
  }
  async stop(cancelAdmission = true) {
    const wasBusy = !["idle", "error"].includes(this.state.phase);
    if (cancelAdmission) ++this.admission;
    const generation = ++this.generation;
    try {
      this.controller?.abort();
      if (this.source) {
        try {
          this.source.stop();
        } catch {
          /* Already ended. */
        }
        this.source = null;
      }
      this.finishPlayback?.();
      this.finishPlayback = null;
      const context = this.context;
      this.context = null;
      const release = this.releaseWorker();
      await Promise.all([
        context && context.state !== "closed"
          ? context.close()
          : Promise.resolve(),
        release,
      ]);
      if (generation === this.generation)
        this.update({
          phase: "idle",
          progress: null,
          ...(cancelAdmission && wasBusy
            ? { message: "Offline speech stopped." }
            : {}),
        });
    } catch (cause) {
      if (generation === this.generation) this.fail(cause);
      throw cause;
    }
  }
}

function wav(samples: Float32Array, rate: number) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  for (const [offset, word] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const)
    for (let i = 0; i < word.length; i++)
      view.setUint8(offset + i, word.charCodeAt(i));
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    view.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767),
      true,
    );
  return new Blob([bytes], { type: "audio/wav" });
}

export const mobileSpeech: OfflineSpeech = new BrowserSpeech();
