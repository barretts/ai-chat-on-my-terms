import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import {
  createElevenLabsVoices,
  createXaiVoices,
  type CloudVoiceProvider,
} from "@locallab/speech-cloud";
import type { FetchLike } from "@locallab/network-http";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import type { SystemSpeechOutputPort } from "@locallab/speech-system";
import type { OfflineSpeech } from "../../platform/speech/types";
import type { OfflineTranscription } from "../../platform/whisper/types";
import type {
  ImportedTranscription,
  ReadAloudTarget,
  SQLiteTranscriptionImportStore,
} from "./index";

const AUDIO_TYPES = [
  "audio/*",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".mp4",
];
const KNOWN_EXTENSIONS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "flac",
  "mp4",
] as const;
const RETAINED_DIRECTORY = "voice-transcriptions";

function importId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function extensionOf(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return (KNOWN_EXTENSIONS as readonly string[]).includes(extension)
    ? extension
    : "m4a";
}

/** Opaque references only; raw keys must never reach chat storage. */
function asSecretRef(value: string): SecretRef {
  if (!/^sec_[0-9a-f-]{36}$/i.test(value))
    throw new Error(
      "This connection stores its API key as an opaque reference from the vault.",
    );
  return value as SecretRef;
}

function mergeChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export interface VoiceStudioConnectionRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly host: string;
  readonly credentialRef: string | null;
}

export interface VoiceStudioPorts {
  readonly whisper: OfflineTranscription;
  readonly imports: SQLiteTranscriptionImportStore;
  readonly offlineSpeech: OfflineSpeech;
  readonly systemSpeech: SystemSpeechOutputPort;
  readonly secrets: SecretStore;
  readonly connections: {
    list(): Promise<readonly VoiceStudioConnectionRow[]>;
  };
  readonly fetch?: FetchLike;
}

export interface VoiceStudio {
  /** Picks an audio file, keeps a copy, transcribes it and stores the row. */
  importFile(
    signal?: AbortSignal,
    locale?: string,
  ): Promise<ImportedTranscription>;
  /** Resolves when playback finishes; a newer play replaces the older one. */
  play(audioUri: string): Promise<void>;
  stopPlayback(): Promise<void>;
  /** Speaks one reply with the resolved engine, or explains what is missing. */
  readAloud(
    target: ReadAloudTarget,
    text: string,
    locale: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Expo wiring for Voice Studio (VO-05/06/15/16): document import, durable
 * audio copies with a retained player, file transcription through the shared
 * Whisper service, and read-aloud dispatch to the engine the settings chose.
 */
export function createVoiceStudio(ports: VoiceStudioPorts): VoiceStudio {
  let player: AudioPlayer | null = null;
  let finishPlayback: (() => void) | null = null;
  let playbackListener: { remove(): void } | null = null;
  let generation = 0;

  async function stopPlayback(): Promise<void> {
    generation += 1;
    const current = player;
    player = null;
    playbackListener?.remove();
    playbackListener = null;
    const finish = finishPlayback;
    finishPlayback = null;
    if (!current) return;
    try {
      current.pause();
      current.release();
    } catch {
      // Releasing an already-finished player is fine.
    }
    finish?.();
  }

  async function playUri(audioUri: string): Promise<void> {
    await stopPlayback();
    const owned = generation;
    await setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      shouldPlayInBackground: false,
    });
    const created = createAudioPlayer(audioUri, { updateInterval: 200 });
    player = created;
    try {
      await new Promise<void>((resolve, reject) => {
        finishPlayback = () => {
          if (generation !== owned) resolve();
          else reject(new Error("Playback was replaced by newer audio."));
        };
        playbackListener = created.addListener(
          "playbackStatusUpdate",
          (status) => {
            if (generation !== owned) return resolve();
            if (status.error) {
              reject(
                new Error(
                  `Playback failed: ${status.error}. The recording may use a codec this device cannot decode.`,
                ),
              );
              return;
            }
            if (status.didJustFinish) resolve();
          },
        );
        created.play();
      });
    } finally {
      if (finishPlayback && generation === owned) {
        finishPlayback = null;
        playbackListener?.remove();
        playbackListener = null;
        created.pause();
        created.release();
        if (player === created) player = null;
      }
    }
  }

  function providerFor(
    providerId: "elevenlabs" | "xai",
    connectionId: string,
    speed: number,
  ): Promise<CloudVoiceProvider> {
    return ports.connections
      .list()
      .then((rows) => {
        const row = rows.find((candidate) => candidate.id === connectionId);
        if (!row)
          throw new Error(
            "The API connection chosen for this Persona no longer exists. Pick it again in Voice settings.",
          );
        if (row.kind !== providerId)
          throw new Error(
            `This Persona's voice expects a ${providerId} connection, but "${row.name ?? row.id}" is a ${row.kind} connection.`,
          );
        if (!row.credentialRef)
          throw new Error(
            "Save this connection's API key first; cloud voices only accept stored references.",
          );
        const apiKeyRef = asSecretRef(row.credentialRef);
        const resolveConnection = async () => ({
          ...(row.host ? { origin: row.host } : {}),
          apiKeyRef,
        });
        const base = {
          secrets: ports.secrets,
          resolveConnection,
          fetch: ports.fetch ?? globalThis.fetch,
          personaConnectionId: connectionId,
        };
        return providerId === "elevenlabs"
          ? createElevenLabsVoices({ ...base, settings: { speed } })
          : createXaiVoices({ ...base, speed });
      });
  }

  async function speakCloud(
    providerId: "elevenlabs" | "xai",
    connectionId: string,
    voiceId: string,
    speed: number,
    text: string,
    locale: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const provider = await providerFor(providerId, connectionId, speed);
    const chunks: Uint8Array[] = [];
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const result = await provider.synthesize({
      text,
      voiceId,
      ...(locale ? { language: locale } : {}),
      speed,
      signal: controller.signal,
      onChunk: (bytes) => chunks.push(bytes),
    });
    signal?.removeEventListener("abort", abort);
    if (controller.signal.aborted) return;
    if (!result.ok) throw new Error(result.error.message);
    const cache = new Directory(Paths.cache, "voice-read-aloud");
    cache.create({ intermediates: true, idempotent: true });
    const file = new File(cache, `voice-${importId()}.mp3`);
    file.create({ overwrite: true });
    file.write(mergeChunks(chunks));
    await playUri(file.uri);
    file.delete();
  }

  return {
    async importFile(signal, locale) {
      signal?.throwIfAborted();
      const picked = await DocumentPicker.getDocumentAsync({
        type: AUDIO_TYPES,
        copyToCacheDirectory: true,
        multiple: false,
      });
      signal?.throwIfAborted();
      if (picked.canceled) throw new Error("File import was canceled.");
      const asset = picked.assets[0];
      if (!asset) throw new Error("No audio file was selected.");
      const id = importId();
      const name = asset.name.trim().slice(0, 200) || "imported-audio";
      const directory = new Directory(Paths.document, RETAINED_DIRECTORY);
      directory.create({ intermediates: true, idempotent: true });
      const destination = new File(directory, `${id}.${extensionOf(name)}`);
      new File(asset.uri).move(destination);
      const recordBase = {
        id,
        name,
        audioUri: destination.uri,
        createdAt: Date.now(),
      };
      try {
        const text = await ports.whisper.transcribeFile(
          destination.uri,
          locale ? { language: locale } : undefined,
        );
        const record = { ...recordBase, text };
        await ports.imports.add(record);
        return record;
      } catch (cause) {
        // Keep the playable copy; only the transcript step failed.
        await ports.imports.add({ ...recordBase, text: "" });
        throw cause;
      }
    },
    play: (audioUri) => playUri(audioUri),
    stopPlayback,
    async readAloud(target, text, locale, signal) {
      switch (target.kind) {
        case "unbound":
          throw new Error(target.message);
        case "offline":
          await ports.offlineSpeech.speak(text, target.voiceId, target.rate);
          return;
        case "system": {
          const result = await ports.systemSpeech.speak(text, {
            rate: target.rate,
            pitch: target.pitch,
            ...(target.language ? { language: target.language } : {}),
            ...(signal ? { signal } : {}),
          });
          if (!result.ok) throw new Error(result.error.message);
          return;
        }
        case "cloud":
          await speakCloud(
            target.provider,
            target.connectionId,
            target.voiceId,
            target.speed,
            text,
            locale,
            signal,
          );
          return;
      }
    },
  };
}
