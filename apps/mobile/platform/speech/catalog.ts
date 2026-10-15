import type { SpeechVoice } from "./types";

export const speechModels = [
  {
    id: "kokoro-v1",
    name: "Kokoro 82M",
    type: "kokoro" as const,
    language: "en-US",
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
    language: "en-US",
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
  {
    id: "piper-thorsten-de",
    name: "Piper Thorsten (German)",
    type: "vits" as const,
    language: "de-DE",
    sizeLabel: "About 67 MB",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2",
    archiveBytes: 67214254,
    archiveSha256:
      "50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714",
    directory: "vits-piper-de_DE-thorsten-medium",
    modelFile: "de_DE-thorsten-medium.onnx",
    license: "CC0",
    licenseUrl:
      "https://huggingface.co/rhasspy/piper-voices/blob/main/de/de_DE/thorsten/medium/MODEL_CARD",
  },
  {
    id: "piper-denis-ru",
    name: "Piper Denis (Russian)",
    type: "vits" as const,
    language: "ru-RU",
    sizeLabel: "About 67 MB",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-denis-medium.tar.bz2",
    archiveBytes: 67190991,
    archiveSha256:
      "efa4c18e0b5e32b81d1b6df36b9d312831e5d545200e27848ef926a4cd930300",
    directory: "vits-piper-ru_RU-denis-medium",
    modelFile: "ru_RU-denis-medium.onnx",
    license: "CC0",
    licenseUrl:
      "https://huggingface.co/rhasspy/piper-voices/blob/main/ru/ru_RU/denis/medium/MODEL_CARD",
  },
  {
    id: "piper-davefx-es",
    name: "Piper DaveFX (Spanish)",
    type: "vits" as const,
    language: "es-ES",
    sizeLabel: "About 67 MB",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_ES-davefx-medium.tar.bz2",
    archiveBytes: 67184952,
    archiveSha256:
      "a3f6beb54a9cb893279f72978a22f807a4d9fc9c7848157b524d5cc7b7f58b22",
    directory: "vits-piper-es_ES-davefx-medium",
    modelFile: "es_ES-davefx-medium.onnx",
    license: "CC0",
    licenseUrl:
      "https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_ES/davefx/medium/MODEL_CARD",
  },
  {
    id: "piper-siwis-fr",
    name: "Piper Siwis (French)",
    type: "vits" as const,
    language: "fr-FR",
    sizeLabel: "About 67 MB",
    archiveUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-fr_FR-siwis-medium.tar.bz2",
    archiveBytes: 67207459,
    archiveSha256:
      "375909aa30842b3a4efa10b1beb1d761af792960ae6873b4d53889f96c66195b",
    directory: "vits-piper-fr_FR-siwis-medium",
    modelFile: "fr_FR-siwis-medium.onnx",
    license: "CC BY 4.0",
    licenseUrl:
      "https://huggingface.co/rhasspy/piper-voices/blob/main/fr/fr_FR/siwis/medium/MODEL_CARD",
  },
] as const;

export const speechVoices: readonly SpeechVoice[] = [
  {
    id: "af_heart",
    name: "Heart",
    modelId: "kokoro-v1",
    speakerId: 3,
    language: "en-US",
    languageName: "English",
    description: "Female · American English · Kokoro",
  },
  {
    id: "af_bella",
    name: "Bella",
    modelId: "kokoro-v1",
    speakerId: 2,
    language: "en-US",
    languageName: "English",
    description: "Female · American English · Kokoro",
  },
  {
    id: "lj",
    name: "Linda",
    modelId: "piper-lj",
    speakerId: 0,
    language: "en-US",
    languageName: "English",
    description: "Female · American English · Piper LJ Speech",
  },
  {
    id: "thorsten",
    name: "Thorsten",
    modelId: "piper-thorsten-de",
    speakerId: 0,
    language: "de-DE",
    languageName: "German",
    description: "Male · German · Piper",
  },
  {
    id: "denis",
    name: "Denis",
    modelId: "piper-denis-ru",
    speakerId: 0,
    language: "ru-RU",
    languageName: "Russian",
    description: "Male · Russian · Piper",
  },
  {
    id: "davefx",
    name: "DaveFX",
    modelId: "piper-davefx-es",
    speakerId: 0,
    language: "es-ES",
    languageName: "Spanish",
    description: "Male · European Spanish · Piper",
  },
  {
    id: "siwis",
    name: "Siwis",
    modelId: "piper-siwis-fr",
    speakerId: 0,
    language: "fr-FR",
    languageName: "French",
    description: "Female · French · Piper",
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

const languageRows: { tag: string; label: string }[] = [];
const seenLanguages: Record<string, true> = {};
for (const item of speechVoices) {
  if (seenLanguages[item.language]) continue;
  seenLanguages[item.language] = true;
  languageRows.push({ tag: item.language, label: item.languageName });
}
/** One entry per downloadable language, for the Voice Studio picker. */
export const speechLanguages: readonly { tag: string; label: string }[] =
  languageRows;
