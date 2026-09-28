import type { SpeechVoice } from "./types";

export const speechModels = [
  {
    id: "kokoro-v1",
    name: "Kokoro 82M",
    type: "kokoro" as const,
    sizeLabel: "About 360 MB",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
    archiveBytes: 349906910,
    archiveSha256:
      "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298",
    directory: "kokoro-multi-lang-v1_0",
    modelFile: "model.onnx",
    license: "Apache 2.0",
    licenseUrl: "https://huggingface.co/hexgrad/Kokoro-82M",
  },
  {
    id: "piper-lj",
    name: "Piper LJ Speech",
    type: "vits" as const,
    sizeLabel: "About 120 MB",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-ljspeech-high.tar.bz2",
    archiveBytes: 115817679,
    archiveSha256:
      "00c6408d2409050312193b0d40ae07fde28af7d3d45a56efcc55440db516b935",
    directory: "vits-piper-en_US-ljspeech-high",
    modelFile: "en_US-ljspeech-high.onnx",
    license: "Public-domain voice dataset",
    licenseUrl:
      "https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/high/MODEL_CARD",
  },
] as const;

export const speechVoices: readonly SpeechVoice[] = [
  {
    id: "af_heart",
    name: "Heart",
    modelId: "kokoro-v1",
    speakerId: 3,
    description: "Female · American English · Kokoro",
  },
  {
    id: "af_bella",
    name: "Bella",
    modelId: "kokoro-v1",
    speakerId: 2,
    description: "Female · American English · Kokoro",
  },
  {
    id: "lj",
    name: "Linda",
    modelId: "piper-lj",
    speakerId: 0,
    description: "Female · American English · Piper LJ Speech",
  },
];

export function speechVoice(id: string) {
  const voice = speechVoices.find((item) => item.id === id);
  if (!voice) throw new Error("Choose an available offline voice.");
  return voice;
}

export function speechModel(id: string) {
  const model = speechModels.find((item) => item.id === id);
  if (!model) throw new Error("Choose an available offline speech model.");
  return model;
}

export function speechText(text: string): string {
  const clean = text.trim();
  if (!clean) throw new Error("Enter text to read aloud.");
  if (clean.length > 3000)
    throw new Error(
      "Read aloud supports up to 3,000 characters at a time. Select a shorter passage.",
    );
  return clean;
}
