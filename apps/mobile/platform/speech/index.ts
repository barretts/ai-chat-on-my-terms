import * as FileSystem from "expo-file-system/legacy";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { speechModel, speechModels, speechText, speechVoice } from "./catalog";
import { SpeechStateStore, speechRate } from "./state";
import type { OfflineSpeech } from "./types";
export { speechModels, speechVoices } from "./catalog";
export type { OfflineSpeech, SpeechState } from "./types";

const root = `${FileSystem.documentDirectory}offline-speech/`;
const selectionPath = `${root}selection.json`;
type Sherpa = typeof import("@siteed/sherpa-onnx.rn").default;

class NativeSpeech extends SpeechStateStore implements OfflineSpeech {
  private sherpa: Sherpa | null = null;
  private loadedModel: string | null = null;
  private download: ReturnType<
    typeof FileSystem.createDownloadResumable
  > | null = null;
  private generation = 0;
  private admission = 0;
  private controller: AbortController | null = null;
  private active: Promise<void> | null = null;
  private player: AudioPlayer | null = null;
  private playbackListener: { remove(): void } | null = null;
  private finishPlayback: (() => void) | null = null;
  private async engine() {
    if (!this.sherpa) {
      try {
        this.sherpa = (await import("@siteed/sherpa-onnx.rn")).default;
      } catch {
        throw new Error(
          "Offline speech requires an iPhone app build containing the Sherpa speech module. It is not included in older installed builds or Expo Go.",
        );
      }
      const result = await this.sherpa.validateLibraryLoaded();
      if (!result.loaded)
        throw new Error(
          "The offline speech module is unavailable in this app build.",
        );
    }
    return this.sherpa;
  }
  async refresh() {
    await FileSystem.makeDirectoryAsync(root, { intermediates: true });
    if ((await FileSystem.getInfoAsync(selectionPath)).exists) {
      try {
        const selection = JSON.parse(
          await FileSystem.readAsStringAsync(selectionPath),
        );
        speechVoice(selection.voiceId);
        this.update({
          selectedVoiceId: selection.voiceId,
          rate: speechRate(selection.rate ?? 1),
        });
      } catch {
        /* Ignore obsolete selection. */
      }
    }
    const installed: string[] = [];
    for (const model of speechModels) {
      const directory = `${root}${model.directory}/`;
      if (!(await FileSystem.getInfoAsync(`${directory}ready.json`)).exists)
        continue;
      try {
        const marker = JSON.parse(
          await FileSystem.readAsStringAsync(`${directory}ready.json`),
        );
        if (
          marker.archiveSha256 !== model.archiveSha256 ||
          marker.archiveBytes !== model.archiveBytes
        )
          continue;
      } catch {
        continue;
      }
      const files = [
        model.modelFile,
        "tokens.txt",
        "espeak-ng-data",
        ...(model.type === "kokoro" ? ["voices.bin", "lexicon-us-en.txt"] : []),
      ];
      if (
        (
          await Promise.all(
            files.map((name) => FileSystem.getInfoAsync(`${directory}${name}`)),
          )
        ).every((info) => info.exists)
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
    await FileSystem.makeDirectoryAsync(root, { intermediates: true });
    await FileSystem.writeAsStringAsync(
      selectionPath,
      JSON.stringify({ voiceId: id, rate: this.state.rate }),
    );
    this.update({
      selectedVoiceId: id,
      message: `${speechVoice(id).name} selected.`,
    });
  }
  async setRate(rate: number) {
    speechRate(rate);
    await this.stop();
    await FileSystem.makeDirectoryAsync(root, { intermediates: true });
    await FileSystem.writeAsStringAsync(
      selectionPath,
      JSON.stringify({ voiceId: this.state.selectedVoiceId, rate }),
    );
    this.update({ rate, message: `Voice speed saved: ${rate}×.` });
  }
  async install(id: string) {
    speechModel(id);
    const admission = ++this.admission;
    await this.stop(false);
    if (admission !== this.admission) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const archive = `${root}${id}.tar.bz2`;
    const operation = this.installModel(id, generation, controller, archive);
    this.active = operation;
    try {
      await operation;
    } finally {
      if (this.active === operation) this.active = null;
    }
  }
  private async installModel(
    id: string,
    generation: number,
    controller: AbortController,
    archive: string,
  ) {
    const model = speechModel(id);
    this.update({
      phase: "downloading",
      message: `Downloading ${model.name} for offline use…`,
      progress: 0,
    });
    try {
      const sherpa = await this.engine();
      await FileSystem.makeDirectoryAsync(root, { intermediates: true });
      controller.signal.throwIfAborted();
      if (Paths.availableDiskSpace < model.archiveBytes * 3 + 64 * 1024 * 1024)
        throw new Error(
          "Not enough free space to download and unpack this voice. Free some storage or choose Linda's smaller pack.",
        );
      const download = FileSystem.createDownloadResumable(
        model.archiveUrl,
        archive,
        { sessionType: FileSystem.FileSystemSessionType.FOREGROUND },
        (progress) => {
          if (generation === this.generation)
            this.update({
              progress:
                progress.totalBytesExpectedToWrite > 0
                  ? progress.totalBytesWritten /
                    progress.totalBytesExpectedToWrite
                  : null,
            });
        },
      );
      this.download = download;
      const result = await download.downloadAsync();
      if (generation !== this.generation) return;
      if (!result || result.status !== 200)
        throw new Error("Voice model download failed.");
      this.download = null;
      this.update({
        phase: "loading",
        message: "Download complete. Preparing your offline voice…",
        progress: null,
      });
      controller.signal.throwIfAborted();
      if (new File(archive).size !== model.archiveBytes)
        throw new Error("The voice download is incomplete. Download it again.");
      this.update({
        phase: "loading",
        message: "Unpacking your voice. Keep the app open for this final step…",
        progress: null,
      });
      const extracted = await sherpa.Archive.extractTarBz2(archive, root);
      if (!extracted.success)
        throw new Error(extracted.message || "Voice model extraction failed.");
      const directory = `${root}${model.directory}/`;
      const files = [
        model.modelFile,
        "tokens.txt",
        "espeak-ng-data",
        ...(model.type === "kokoro" ? ["voices.bin", "lexicon-us-en.txt"] : []),
      ];
      for (const name of files)
        if (!(await FileSystem.getInfoAsync(`${directory}${name}`)).exists)
          throw new Error(`Incomplete offline voice: ${name}`);
      if (generation !== this.generation) return;
      await FileSystem.writeAsStringAsync(
        `${directory}ready.json`,
        JSON.stringify({
          modelId: id,
          archiveSha256: model.archiveSha256,
          archiveBytes: model.archiveBytes,
          verification: "size-only",
          installedAt: new Date().toISOString(),
        }),
      );
      await FileSystem.deleteAsync(archive, { idempotent: true });
      await this.refresh();
      this.update({
        phase: "idle",
        progress: null,
        message: `${model.name} saved on this device. Reading aloud works offline.`,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(error);
      throw error;
    } finally {
      this.download = null;
      if (this.controller === controller) this.controller = null;
      await FileSystem.deleteAsync(archive, { idempotent: true });
    }
  }
  async remove(id: string) {
    const model = speechModel(id);
    const admission = ++this.admission;
    await this.stop(false);
    if (admission !== this.admission) return;
    if (this.sherpa && this.loadedModel === id) {
      await this.sherpa.TTS.release();
      this.loadedModel = null;
    }
    await FileSystem.deleteAsync(`${root}${model.directory}`, {
      idempotent: true,
    });
    await this.refresh();
    this.update({ message: "Offline voice model removed." });
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
    const work = async () => {
      try {
        const clean = speechText(text);
        speechRate(rate);
        const voice = speechVoice(id);
        if (!this.state.installedModelIds.includes(voice.modelId))
          throw new Error("Download this voice model before reading aloud.");
        const sherpa = await this.engine();
        const model = speechModel(voice.modelId);
        const directory = `${root}${model.directory}/`;
        this.update({
          phase: "loading",
          message: `Loading ${voice.name} on this device…`,
        });
        if (this.loadedModel !== model.id) {
          const result = await sherpa.TTS.initialize({
            modelDir: directory,
            ttsModelType: model.type,
            modelFile: model.modelFile,
            tokensFile: "tokens.txt",
            dataDir: "espeak-ng-data",
            numThreads: 2,
            provider: "cpu",
            ...(model.type === "kokoro"
              ? {
                  voicesFile: "voices.bin",
                  lexiconFile: "lexicon-us-en.txt",
                  lang: "en-us",
                }
              : {}),
          });
          if (!result.success || result.numSpeakers <= voice.speakerId)
            throw new Error(result.error || "Offline voice failed to load.");
          this.loadedModel = model.id;
        }
        if (generation !== this.generation) return;
        this.update({
          phase: "generating",
          message: `Generating ${voice.name} audio offline…`,
        });
        const result = await sherpa.TTS.generateSpeech(clean, {
          speakerId: voice.speakerId,
          speakingRate: rate,
          playAudio: false,
          fileNamePrefix: `locallab-speech-${Date.now()}-${generation}`,
        });
        if (generation !== this.generation) {
          if (result.filePath)
            await FileSystem.deleteAsync(
              result.filePath.startsWith("file:")
                ? result.filePath
                : `file://${result.filePath}`,
              { idempotent: true },
            );
          return;
        }
        if (!result.success || !result.filePath)
          throw new Error("Offline voice did not produce an audio file.");
        const audioUri = result.filePath.startsWith("file:")
          ? result.filePath
          : `file://${result.filePath}`;
        if (this.state.audioUri)
          await FileSystem.deleteAsync(this.state.audioUri, {
            idempotent: true,
          });
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: false,
          shouldPlayInBackground: false,
        });
        if (generation !== this.generation) {
          await FileSystem.deleteAsync(audioUri, { idempotent: true });
          return;
        }
        const player = createAudioPlayer(audioUri, { updateInterval: 100 });
        this.player = player;
        this.update({
          audioUri,
          message: `${voice.name} audio generated offline. Loading playback…`,
        });
        await new Promise<void>((resolve, reject) => {
          this.finishPlayback = resolve;
          this.playbackListener = player.addListener(
            "playbackStatusUpdate",
            (status) => {
              if (generation !== this.generation) return;
              if (status.error) {
                reject(new Error(status.error));
                return;
              }
              if (status.playing)
                this.update({
                  phase: "playing",
                  message: `${voice.name} is reading aloud. Audio generated offline.`,
                });
              if (status.didJustFinish) resolve();
            },
          );
          player.play();
        });
        this.playbackListener?.remove();
        this.playbackListener = null;
        this.finishPlayback = null;
        if (this.player === player) {
          player.release();
          this.player = null;
        }
        if (generation === this.generation)
          this.update({
            phase: "idle",
            message: `${voice.name} finished reading aloud. Audio generated offline.`,
          });
      } catch (error) {
        if (generation === this.generation) {
          this.playbackListener?.remove();
          this.playbackListener = null;
          this.finishPlayback = null;
          this.player?.pause();
          this.player?.release();
          this.player = null;
          this.fail(error);
          throw error;
        }
      }
    };
    const operation = work();
    this.active = operation;
    try {
      await operation;
    } finally {
      if (this.active === operation) this.active = null;
    }
  }
  async stop(cancelAdmission = true) {
    const wasBusy = !!this.active || !!this.download || !!this.player;
    if (cancelAdmission) ++this.admission;
    const generation = ++this.generation;
    if (this.active || this.download)
      this.update({ message: "Stopping offline speech…" });
    this.controller?.abort();
    this.playbackListener?.remove();
    this.playbackListener = null;
    this.player?.pause();
    this.player?.release();
    this.player = null;
    this.finishPlayback?.();
    this.finishPlayback = null;
    const download = this.download;
    this.download = null;
    const active = this.active;
    const cancelDownload = download?.cancelAsync().catch(() => undefined);
    const stopSpeech = this.sherpa?.TTS.stopSpeech();
    // Native inference must drain before a second model can replace its resources.
    await Promise.all([
      cancelDownload,
      stopSpeech,
      active?.catch(() => undefined),
    ]);
    if (generation === this.generation)
      this.update({
        phase: "idle",
        progress: null,
        ...(cancelAdmission && wasBusy
          ? { message: "Offline speech stopped." }
          : {}),
      });
  }
}

export const mobileSpeech: OfflineSpeech = new NativeSpeech();
