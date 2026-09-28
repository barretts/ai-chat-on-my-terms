export class ForegroundRunSuspendedError extends Error {
  constructor() {
    super(
      "Chat was paused while the app was inactive. Return to the chat and try again.",
    );
    this.name = "ForegroundRunSuspendedError";
  }
}

/** A foreground transition cannot revive work captured before suspension. */
export class ForegroundRunAdmission {
  private epoch = 0;

  constructor(private readonly isActive: () => boolean) {}

  suspend(): void {
    this.epoch += 1;
  }

  begin() {
    const epoch = this.epoch;
    const isCurrent = () => epoch === this.epoch && this.isActive();
    const assertActive = () => {
      if (!isCurrent()) throw new ForegroundRunSuspendedError();
    };
    return {
      assertActive,
      admit: async <T extends { stop(): Promise<void> }>(
        start: () => Promise<T>,
      ): Promise<T> => {
        assertActive();
        const handle = await start();
        if (!isCurrent()) await handle.stop();
        return handle;
      },
    };
  }
}
