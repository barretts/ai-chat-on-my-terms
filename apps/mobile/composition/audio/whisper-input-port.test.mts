import { describe, expect, it } from "vitest";
import type {
  ListenHandle,
  OfflineTranscription,
  TranscriptionOutcome,
  TranscriptionState,
} from "../../platform/whisper/types";
import { createWhisperInputPort } from "./whisper-input-port";

class FakeWhisper implements OfflineTranscription {
  events: string[] = [];
  stopped = false;
  state: TranscriptionState = {
    phase: "idle",
    modelId: "whisper-small",
    language: "",
    installedModelIds: ["whisper-small"],
    message: "",
    progress: null,
  };
  permissionFails = false;
  private settle: ((outcome: TranscriptionOutcome) => void) | null = null;
  snapshot(): TranscriptionState {
    return { ...this.state };
  }
  subscribe(): () => void {
    return () => {};
  }
  languages = [];
  updates = [];
  async refresh(): Promise<void> {}
  async install(): Promise<void> {}
  cancelInstall(): void {}
  async remove(): Promise<void> {}
  async setModel(): Promise<void> {}
  setLanguage(code: string): void {
    this.events.push(`lang:${code}`);
    this.state.language = code;
  }
  async transcribeFile(): Promise<string> {
    return "";
  }
  async listen(
    signal: AbortSignal,
  ): Promise<{ outcome: Promise<TranscriptionOutcome>; handle: ListenHandle }> {
    this.events.push("listen");
    if (this.permissionFails)
      return {
        outcome: Promise.resolve({
          ok: false,
          code: "permission",
          message: "Microphone permission is not granted.",
        }),
        handle: { stop: () => {} },
      };
    const outcome = new Promise<TranscriptionOutcome>((resolve) => {
      this.settle = resolve;
    });
    signal.addEventListener(
      "abort",
      () =>
        this.settle?.({
          ok: false,
          code: "canceled",
          message: "Transcription canceled.",
        }),
      { once: true },
    );
    return {
      outcome,
      handle: {
        stop: () => {
          this.stopped = true;
          this.settle?.({ ok: true, text: " final text " });
        },
      },
    };
  }
  async dispose(): Promise<void> {
    this.events.push("dispose");
  }
}

describe("whisper input port", () => {
  it("reports availability from installed models", async () => {
    const whisper = new FakeWhisper();
    const port = createWhisperInputPort(whisper);
    expect(await port.getAvailability()).toEqual({ ok: true, value: "ready" });
    whisper.state.installedModelIds = [];
    const unavailable = await port.getAvailability();
    expect(!unavailable.ok && unavailable.error.code).toBe("unavailable");
  });
  it("finalizes on signal abort and trims the transcript", async () => {
    const whisper = new FakeWhisper();
    const port = createWhisperInputPort(whisper);
    const controller = new AbortController();
    const partials: string[] = [];
    const listening = port.listen({
      signal: controller.signal,
      locale: "de-DE",
      onPartial: (text) => partials.push(text),
    });
    await Promise.resolve();
    controller.abort();
    expect(await listening).toEqual({ ok: true, value: "final text" });
    expect(whisper.stopped).toBe(true);
    expect(whisper.events).toContain("lang:de");
    expect(partials).toEqual(["final text"]);
    expect(port.operationInfo()).toEqual({ locale: "de-DE", onDevice: true });
  });
  it("discards without recognizing on cancel", async () => {
    const whisper = new FakeWhisper();
    const port = createWhisperInputPort(whisper);
    const listening = port.listen({ signal: new AbortController().signal });
    await Promise.resolve();
    await port.cancel();
    const result = await listening;
    expect(!result.ok && result.error.code).toBe("canceled");
    expect(whisper.stopped).toBe(false);
  });
  it("rejects unknown locales and concurrent listens", async () => {
    const whisper = new FakeWhisper();
    const port = createWhisperInputPort(whisper);
    const bad = await port.listen({
      signal: new AbortController().signal,
      locale: "nl-NL",
    });
    expect(!bad.ok && bad.error.code).toBe("unsupported");
    const first = port.listen({ signal: new AbortController().signal });
    await Promise.resolve();
    const busy = await port.listen({ signal: new AbortController().signal });
    expect(!busy.ok && busy.error.code).toBe("busy");
    await port.cancel();
    await first;
  });
  it("maps permission failure to a recoverable audio failure", async () => {
    const whisper = new FakeWhisper();
    whisper.permissionFails = true;
    const port = createWhisperInputPort(whisper);
    const result = await port.listen({
      signal: new AbortController().signal,
    });
    expect(!result.ok && result.error.code).toBe("permission");
  });
  it("finalizes automatically when the listening cap elapses", async () => {
    const whisper = new FakeWhisper();
    const port = createWhisperInputPort(whisper);
    const result = await port.listen({
      signal: new AbortController().signal,
      maxListeningMs: 20,
    });
    expect(result).toEqual({ ok: true, value: "final text" });
    expect(whisper.stopped).toBe(true);
  });
});
