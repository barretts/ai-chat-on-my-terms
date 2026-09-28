export interface NativeAbortConstructors {
  AbortController: typeof globalThis.AbortController;
  AbortSignal: typeof globalThis.AbortSignal;
}

/** Fill the two missing instance semantics of React Native's abort-controller 3 runtime. */
export function installNativeAbortCompatibility(
  constructors: NativeAbortConstructors = {
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
  },
): void {
  const signalPrototype = constructors.AbortSignal.prototype;
  const controllerPrototype = constructors.AbortController.prototype;
  if (!("reason" in signalPrototype)) {
    const reasons = new WeakMap<AbortSignal, unknown>();
    const defaultReason = () =>
      new DOMException("The operation was aborted.", "AbortError");
    Object.defineProperty(signalPrototype, "reason", {
      configurable: true,
      enumerable: true,
      get(this: AbortSignal): unknown {
        if (!this.aborted) return undefined;
        // Signals aborted before bootstrap have no recoverable original reason.
        if (!reasons.has(this)) reasons.set(this, defaultReason());
        return reasons.get(this);
      },
    });
    const originalAbort = controllerPrototype.abort;
    Object.defineProperty(controllerPrototype, "abort", {
      configurable: true,
      enumerable: true,
      writable: true,
      value(this: AbortController, reason?: unknown): void {
        if (!this.signal.aborted)
          reasons.set(
            this.signal,
            reason === undefined ? defaultReason() : reason,
          );
        originalAbort.call(this, reason);
      },
    });
  }
  if (typeof signalPrototype.throwIfAborted !== "function") {
    Object.defineProperty(signalPrototype, "throwIfAborted", {
      configurable: true,
      writable: true,
      value(this: AbortSignal): void {
        if (this.aborted) throw this.reason;
      },
    });
  }
}
