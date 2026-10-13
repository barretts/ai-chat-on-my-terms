import {
  audioFailure,
  type AudioResult,
  type ListenOptions,
  type SpeechInputPort,
  type SpeakOptions,
  type SpeechOutputPort,
} from "./ports";

export type AudioPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "generating"
  | "speaking";

interface OwnedCapture {
  controller: AbortController;
  settled: Promise<void>;
}

/**
 * Owns capture and playback for one conversation. Capture is always closed
 * before playback starts and owned playback is stopped before capture starts,
 * so the microphone can never transcribe device output. Cancellation uses
 * generations: a canceled or superseded operation cannot change state that a
 * newer operation owns. Disposal first drains the raw settlement promises of
 * every owned operation, because a canceled durable operation does not mean
 * native resources were released.
 */
export class AudioSessionCoordinator {
  private phase: AudioPhase = "idle";
  private generation = 0;
  private capture: OwnedCapture | null = null;
  private pending = new Set<Promise<void>>();
  private draining = false;
  private disposed = false;
  private listeners = new Set<() => void>();

  constructor(
    private readonly input: SpeechInputPort,
    private readonly output: SpeechOutputPort,
  ) {}

  getPhase(): AudioPhase {
    return this.phase;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts recognition, taking control away from any owned work first. */
  async listen(
    options: Omit<ListenOptions, "signal"> & { signal?: AbortSignal } = {},
  ): Promise<AudioResult<string>> {
    if (this.disposed || this.draining)
      return audioFailure("draining", "The audio session is closing.", false);
    const generation = ++this.generation;
    await this.releaseOwned();
    if (this.disposed || this.draining)
      return audioFailure("draining", "The audio session is closing.", false);
    if (options.signal?.aborted)
      return audioFailure("canceled", "Recognition was canceled.", true);
    const controller = new AbortController();
    const abortFromUser = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromUser, { once: true });
    let settleCapture!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleCapture = resolve;
    });
    this.capture = { controller, settled };
    this.pending.add(settled);
    this.setPhase("listening");
    let result: AudioResult<string>;
    try {
      result = await this.input.listen({
        ...(options.locale === undefined ? {} : { locale: options.locale }),
        signal: controller.signal,
        ...(options.onPartial === undefined
          ? {}
          : {
              onPartial: (text: string) => {
                // Partials from superseded turns must not reach the app.
                if (
                  generation === this.generation &&
                  this.capture?.controller === controller
                )
                  options.onPartial?.(text);
              },
            }),
      });
    } catch (cause) {
      result = audioFailure(
        "failed",
        cause instanceof Error ? cause.message : "Recognition failed.",
        true,
      );
    } finally {
      options.signal?.removeEventListener("abort", abortFromUser);
      if (this.capture?.controller === controller) this.capture = null;
      settleCapture();
      this.pending.delete(settled);
    }
    if (generation !== this.generation)
      return audioFailure("canceled", "Recognition was replaced.", true);
    this.setPhase("transcribing");
    await Promise.resolve();
    if (generation !== this.generation)
      return audioFailure("canceled", "Recognition was replaced.", true);
    this.setPhase("idle");
    return result;
  }

  /** Reads text aloud after closing capture, so output is never transcribed. */
  async speak(text: string, options: SpeakOptions): Promise<AudioResult<void>> {
    if (this.disposed || this.draining)
      return audioFailure("draining", "The audio session is closing.", false);
    const generation = ++this.generation;
    await this.releaseOwned();
    if (this.disposed || this.draining)
      return audioFailure("draining", "The audio session is closing.", false);
    if (text.trim() === "") return { ok: true, value: undefined };
    let settlePlayback!: () => void;
    const settled = new Promise<void>((resolve) => {
      settlePlayback = resolve;
    });
    this.pending.add(settled);
    this.setPhase("speaking");
    let result: AudioResult<void>;
    try {
      result = await this.output.speak(text, options);
    } catch (cause) {
      result = audioFailure(
        "failed",
        cause instanceof Error ? cause.message : "Playback failed.",
        true,
      );
    } finally {
      settlePlayback();
      this.pending.delete(settled);
    }
    if (generation !== this.generation)
      return audioFailure("canceled", "Playback was replaced.", true);
    this.setPhase("idle");
    return result;
  }

  /**
   * Stops only work this session owns. Repeated calls are safe, and a stopped
   * capture never restarts automatically: capture resumes only on an explicit
   * listen.
   */
  async stop(): Promise<AudioResult<void>> {
    this.generation++;
    const release = await this.releaseOwned();
    this.setPhase("idle");
    return release;
  }

  /** Optional phase marker for model generation between turns. */
  beginGenerating(): AudioResult<void> {
    if (this.disposed || this.draining)
      return audioFailure("draining", "The audio session is closing.", false);
    if (this.phase !== "idle" && this.phase !== "transcribing")
      return audioFailure("busy", "Capture or playback is active.", true);
    this.setPhase("generating");
    return { ok: true, value: undefined };
  }

  endGenerating(): void {
    if (this.phase === "generating") this.setPhase("idle");
  }

  /**
   * Settles every owned operation before releasing native resources. New
   * admission is refused while draining.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.draining = true;
    this.generation++;
    await this.releaseOwned();
    const pending = [...this.pending];
    await Promise.all(
      pending.map((promise) => promise.then(
        () => undefined,
        () => undefined,
      )),
    );
    this.draining = false;
    this.disposed = true;
    await Promise.all([this.input.dispose?.(), this.output.dispose?.()]);
    this.setPhase("idle");
  }

  /** Closes owned capture, then stops owned playback; awaits both. */
  private async releaseOwned(): Promise<AudioResult<void>> {
    let failure: AudioResult<void> = { ok: true, value: undefined };
    if (this.capture) {
      const capture = this.capture;
      capture.controller.abort();
      await capture.settled;
    }
    if (this.output.isSpeaking()) {
      try {
        const stopped = await this.output.stop();
        if (!stopped.ok) failure = stopped;
      } catch {
        failure = audioFailure(
          "failed",
          "Playback could not be stopped.",
          true,
        );
      }
    }
    return failure;
  }

  private setPhase(phase: AudioPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    for (const listener of this.listeners) listener();
  }
}
