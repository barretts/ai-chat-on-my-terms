/**
 * Local Whisper transcription model catalog (T077, VO-08).
 *
 * int8 ONNX exports of OpenAI Whisper published by the sherpa-onnx project.
 * `bytes` values were read from the Hugging Face API on 2026-10-13; installs
 * verify by exact byte size (the CDN publishes no SHA-256, so verification is
 * honest size-only, recorded in each ready.json marker).
 */

export interface WhisperModelFile {
  name: string;
  url: string;
  bytes: number;
}

export interface WhisperModel {
  id: string;
  name: string;
  /** BCP-47-free short size name shown in the picker, e.g. "small". */
  size: string;
  sizeLabel: string;
  /** Fit guidance shown before downloading. */
  guidance: string;
  files: readonly [WhisperModelFile, WhisperModelFile, WhisperModelFile];
  /** Staging plus installed bytes must fit in free disk. */
  requiredFreeBytes: number;
  totalBytes: number;
  directory: string;
}

const host = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-";
const tokens = 816730;

function whisperModel(
  size: "tiny" | "base" | "small" | "medium" | "large-v3",
  name: string,
  sizeLabel: string,
  guidance: string,
  encoderBytes: number,
  decoderBytes: number,
): WhisperModel {
  const totalBytes = encoderBytes + decoderBytes + tokens;
  return {
    id: `whisper-${size}`,
    name,
    size,
    sizeLabel,
    guidance,
    requiredFreeBytes: totalBytes * 2 + 64 * 1024 * 1024,
    totalBytes,
    directory: `whisper-${size}-int8`,
    files: [
      {
        name: `${size}-encoder.int8.onnx`,
        url: `${host}${size}/resolve/main/${size}-encoder.int8.onnx`,
        bytes: encoderBytes,
      },
      {
        name: `${size}-decoder.int8.onnx`,
        url: `${host}${size}/resolve/main/${size}-decoder.int8.onnx`,
        bytes: decoderBytes,
      },
      {
        name: "tokens.txt",
        url: `${host}${size}/resolve/main/${size}-tokens.txt`,
        bytes: tokens,
      },
    ],
  };
}

export const whisperModels: readonly WhisperModel[] = [
  whisperModel(
    "tiny",
    "Whisper Tiny",
    "About 104 MB",
    "Fastest and smallest. Good for short notes on any supported iPhone.",
    12937772,
    89855401,
  ),
  whisperModel(
    "base",
    "Whisper Base",
    "About 161 MB",
    "Slightly more accurate than Tiny at similar speed.",
    29120534,
    130672026,
  ),
  whisperModel(
    "small",
    "Whisper Small",
    "About 375 MB",
    "Best balance for everyday dictation on current iPhones.",
    112442483,
    262226114,
  ),
  whisperModel(
    "medium",
    "Whisper Medium",
    "About 946 MB",
    "Noticeably better on accents, but slow on older devices.",
    374196283,
    571059257,
  ),
  whisperModel(
    "large-v3",
    "Whisper Large v3",
    "About 1.8 GB",
    "Highest accuracy. Only download on a high-storage iPhone; expect slow passes. Only the int8 export is offered.",
    766671985,
    1008265203,
  ),
];

/**
 * Language hints for multilingual Whisper. Empty means auto-detect.
 * The four downloaded TTS languages are included deliberately.
 */
export const whisperLanguages: readonly { code: string; label: string }[] = [
  { code: "", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "ru", label: "Russian" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
];

export function whisperModelById(id: string): WhisperModel {
  const model = whisperModels.find((item) => item.id === id);
  if (!model) throw new Error("Choose an available Whisper model.");
  return model;
}
