/* Offline inference with the pinned Sherpa 1.13.0 wasm32 C API.
   The package's JS adapter omits the 28-byte Supertonic config, so it passes
   misplaced rule pointers to this binary. Use the complete upstream layout:
   https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.0/sherpa-onnx/c-api/c-api.h */
self.window = self;
let engine;
let booted = false;

function utf8(text) {
  const size = Module.lengthBytesUTF8(text) + 1;
  const pointer = Module._malloc(size);
  if (!pointer) throw new Error("Offline speech ran out of memory.");
  Module.stringToUTF8(text, pointer, size);
  return pointer;
}

function createEngine(type) {
  // model = 228 bytes (including Supertonic), followed by 16 bytes of rules.
  const config = Module._malloc(244);
  if (!config) throw new Error("Offline speech ran out of memory.");
  Module.HEAPU8.fill(0, config, config + 244);
  const strings = [];
  const text = (offset, value) => {
    const pointer = utf8(value);
    strings.push(pointer);
    Module.setValue(config + offset, pointer, "i32");
  };
  let handle;
  try {
    Module.setValue(config + 32, 1, "i32"); // num_threads
    text(40, "cpu");
    Module.setValue(config + 232, 1, "i32"); // max_num_sentences
    Module.setValue(config + 240, 0.2, "float"); // silence_scale
    if (type === "kokoro") {
      // VITS32 + thread/debug/provider12 + Matcha32 => Kokoro offset76.
      text(76, "/voice/model.onnx");
      text(80, "/voice/voices.bin");
      text(84, "/voice/tokens.txt");
      text(88, "/voice/espeak-ng-data");
      Module.setValue(config + 92, 1, "float");
      text(100, "/voice/lexicon-us-en.txt");
      text(104, "en-us");
    } else if (type === "vits") {
      text(0, "/voice/model.onnx");
      text(8, "/voice/tokens.txt");
      text(12, "/voice/espeak-ng-data");
      Module.setValue(config + 16, 0.667, "float");
      Module.setValue(config + 20, 0.8, "float");
      Module.setValue(config + 24, 1, "float");
    } else throw new Error("Choose an available offline speech model.");
    handle = Module._SherpaOnnxCreateOfflineTts(config);
  } finally {
    for (const pointer of strings) Module._free(pointer);
    Module._free(config);
  }
  if (!handle) throw new Error("Offline speech model failed to load.");
  return {
    sampleRate: Module._SherpaOnnxOfflineTtsSampleRate(handle),
    numSpeakers: Module._SherpaOnnxOfflineTtsNumSpeakers(handle),
    generate({ text, sid, speed }) {
      const pointer = utf8(text);
      let audio;
      try {
        audio = Module._SherpaOnnxOfflineTtsGenerate(
          handle,
          pointer,
          sid,
          speed,
        );
      } finally {
        Module._free(pointer);
      }
      if (!audio) throw new Error("The offline voice returned no audio.");
      try {
        const samplesPointer = Module.HEAPU32[audio / 4];
        const count = Module.HEAP32[audio / 4 + 1];
        const sampleRate = Module.HEAP32[audio / 4 + 2];
        if (
          count <= 0 ||
          sampleRate <= 0 ||
          samplesPointer % 4 ||
          samplesPointer + count * 4 > Module.HEAPU8.length
        )
          throw new Error("The offline voice returned invalid audio.");
        return {
          samples: Module.HEAPF32.slice(
            samplesPointer / 4,
            samplesPointer / 4 + count,
          ),
          sampleRate,
        };
      } finally {
        Module._SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
      }
    },
    free() {
      if (handle) Module._SherpaOnnxDestroyOfflineTts(handle);
      handle = 0;
    },
  };
}

function mkdir(path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    try {
      Module.FS.mkdir(current);
    } catch (error) {
      if (!Module.FS.analyzePath(current).exists) throw error;
    }
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.kind === "load") {
      if (!booted) {
        await new Promise((resolve, reject) => {
          self.Module = {
            instantiateWasm: (imports, receiveInstance) => {
              WebAssembly.instantiate(data.runtime.wasm, imports).then(
                (result) => receiveInstance(result.instance, result.module),
                reject,
              );
              return {};
            },
            onRuntimeInitialized: resolve,
            onAbort: (reason) => reject(new Error(String(reason))),
          };
          importScripts(data.runtime.glue);
        });
        booted = true;
      }
      if (engine) engine.free();
      mkdir("/voice");
      for (const file of data.files) {
        const path = "/voice/" + file.name;
        mkdir(path.slice(0, path.lastIndexOf("/")));
        Module.FS.writeFile(path, new Uint8Array(file.bytes));
      }
      engine = createEngine(data.type);
      if (!engine || !engine.sampleRate || !engine.numSpeakers)
        throw new Error("Offline speech model failed to load.");
      self.postMessage({
        id: data.id,
        sampleRate: engine.sampleRate,
        numSpeakers: engine.numSpeakers,
      });
    } else if (data.kind === "generate") {
      if (!engine) throw new Error("Load an offline voice first.");
      const audio = engine.generate({
        text: data.text,
        sid: data.speakerId,
        speed:
          typeof data.speed === "number" && data.speed >= 0.5 && data.speed <= 2
            ? data.speed
            : 1,
      });
      const samples = new Float32Array(audio.samples);
      if (!samples.length) throw new Error("The voice returned no audio.");
      self.postMessage({ id: data.id, samples, sampleRate: audio.sampleRate }, [
        samples.buffer,
      ]);
    }
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
