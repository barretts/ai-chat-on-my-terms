import type {
  SpeechInputPort,
  SpeechOutputPort,
} from "@locallab/audio-session";

export type ConversationVoicePhase =
  | "idle"
  | "speaking"
  | "listening"
  | "sending";

export interface ConversationVoiceEvent {
  phase: ConversationVoicePhase;
  detail?: string;
}

export interface ConversationParticipantSpeech {
  speakerName: string;
  text: string;
  voiceId?: string;
}

export interface ConversationVoiceSessionOptions {
  input: SpeechInputPort;
  output: SpeechOutputPort;
  /** Fires with the user transcript the app should send as the next turn. */
  onUserText(text: string): void;
  onEvent?(event: ConversationVoiceEvent): void;
}

/**
 * Cancelable speak/listen cycle for continuous/group voice (VO-11, VO-12,
 * GR-13). Participant replies play in order with each speaker's own voice;
 * the session then listens for one user utterance and hands the transcript
 * to `onUserText`. Every phase honors cancel(): playback stops through the
 * port, capture aborts through its signal, and a canceled phase never
 * re-enters the cycle.
 */
export class ConversationVoiceSession {
  private phase: ConversationVoicePhase = "idle";
  private controller: AbortController | null = null;
  private running = false;

  constructor(private readonly options: ConversationVoiceSessionOptions) {}

  currentPhase(): ConversationVoicePhase {
    return this.phase;
  }

  /** True while a listen cycle (speak → listen → send) is active. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * One continuous cycle: play the ordered participant replies, capture one
   * user utterance, report it for sending, then return to idle. Returns the
   * transcript when the loop completed, null when canceled, or throws
   * through the returned result for honest capture failures.
   */
  async runCycle(
    replies: readonly ConversationParticipantSpeech[],
  ): Promise<string | null> {
    if (this.running) {
      throw new Error(
        "A voice conversation cycle is already running; stop it first.",
      );
    }
    this.running = true;
    this.controller = new AbortController();
    try {
      for (const reply of replies) {
        if (this.controller.signal.aborted) return null;
        this.setPhase("speaking", reply.speakerName);
        if (this.options.output.isSpeaking())
          await this.options.output.stop();
        const spoken = await this.options.output.speak(reply.text, {
          ...(reply.voiceId ? { voiceId: reply.voiceId } : {}),
          signal: this.controller.signal,
        });
        if (!spoken.ok) {
          this.setPhase("idle", `playback failed: ${spoken.error.message}`);
          return null;
        }
      }
      if (this.controller.signal.aborted) return null;
      this.setPhase("listening");
      const captured = await this.options.input.listen({
        signal: this.controller.signal,
      });
      if (!captured.ok) {
        this.setPhase("idle", `capture failed: ${captured.error.message}`);
        return null;
      }
      if (this.controller.signal.aborted) return null;
      if (captured.value.trim() !== "") {
        this.setPhase("sending");
        this.options.onUserText(captured.value);
      }
      this.setPhase("idle");
      return captured.value;
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  /** Stop the current phase; never starts capture after cancel. */
  async cancel(): Promise<void> {
    this.controller?.abort();
    try {
      const stopped = await this.options.output.stop();
      if (!stopped.ok && stopped.error.code !== "busy")
        this.setPhase(this.phase, `stop failed: ${stopped.error.message}`);
    } catch {
      // The coordinator already owns a released device; a throwing stop
      // after cancellation must not surface as a new failure path.
    }
    this.setPhase("idle", "canceled");
  }

  private setPhase(phase: ConversationVoicePhase, detail?: string): void {
    this.phase = phase;
    this.options.onEvent?.({
      phase,
      ...(detail ? { detail } : {}),
    });
  }
}

