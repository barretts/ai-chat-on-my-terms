import type { SpeechState } from "./types";
import { errorDetails } from "@locallab/network-http";

export class SpeechStateStore {
  protected state: SpeechState = {
    phase: "idle",
    selectedVoiceId: "af_heart",
    installedModelIds: [],
    message: "Download a voice model once, then read aloud locally.",
    progress: null,
    audioUri: null,
    rate: 1,
  };
  private listeners = new Set<() => void>();
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected update(values: Partial<SpeechState>) {
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }
  protected fail(error: unknown) {
    this.update({
      phase: "error",
      progress: null,
      message: speechFailureDetails(error),
    });
  }
}

/** Preserve native/browser failure causes for the visible speech error card. */
export function speechFailureDetails(cause: unknown): string {
  return errorDetails(cause);
}

export function speechRate(value: number): number {
  if (!Number.isFinite(value) || value < 0.5 || value > 2)
    throw new Error("Choose a voice speed between 0.5× and 2×.");
  return value;
}
