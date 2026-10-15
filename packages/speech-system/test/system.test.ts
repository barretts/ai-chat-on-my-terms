import { describe, expect, it } from "vitest";
import {
  createSpeechSystemInput,
  type NativePermission,
  type NativeResult,
  type NativeSpeechSystem,
  type PartialEvent,
} from "../src/index.js";

class FakeNative implements NativeSpeechSystem {
  calls: string[] = [];
  permission: NativePermission = "granted";
  onDeviceSupported = true;
  locales = ["de-DE", "en-US"];
  startResult: NativeResult<{ locale: string; onDevice: boolean }> = {
    ok: true,
    value: { locale: "en-US", onDevice: true },
  };
  stopResult: NativeResult<{ text: string }> = {
    ok: true,
    value: { text: "hello world" },
  };
  active: string[] = [];
  requestPermissionCalls = 0;
  private listeners: ((event: PartialEvent) => void)[] = [];

  async getAvailability() {
    this.calls.push("getAvailability");
    return {
      ok: true as const,
      value: {
        availability:
          this.permission === "granted"
            ? ("ready" as const)
            : this.permission === "notDetermined"
              ? ("ready" as const)
              : this.permission === "restricted"
                ? ("unavailable" as const)
                : ("permission" as const),
        permission: this.permission,
        onDeviceSupported: this.onDeviceSupported,
        locales: this.locales,
      },
    };
  }
  async requestPermission() {
    this.requestPermissionCalls += 1;
    this.calls.push("requestPermission");
    return { ok: true as const, value: { permission: this.permission } };
  }
  async startListening(options: {
    requestId: string;
    locale?: string;
    onDeviceOnly: boolean;
  }) {
    this.calls.push(
      `start:${options.requestId}:onDeviceOnly=${String(options.onDeviceOnly)}`,
    );
    this.active.push(options.requestId);
    return this.startResult;
  }
  async stopListening(options: { requestId: string }) {
    this.calls.push(`stop:${options.requestId}`);
    this.active = this.active.filter((id) => id !== options.requestId);
    return this.stopResult;
  }
  async cancelListening(options: { requestId: string }) {
    this.calls.push(`cancel:${options.requestId}`);
    this.active = this.active.filter((id) => id !== options.requestId);
    return { ok: true as const, value: null };
  }
  addListener(_event: "partial", listener: (payload: PartialEvent) => void) {
    this.listeners.push(listener);
    return {
      remove: () => {
        this.listeners = this.listeners.filter((x) => x !== listener);
      },
    };
  }
  emit(requestId: string, text: string) {
    for (const listener of [...this.listeners])
      listener({ requestId, text, isFinal: false });
  }
  listenerCount() {
    return this.listeners.length;
  }
}

function flush() {
  // Drain the deterministic microtask chain the fake awaits create.
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve());
}

describe("dictation permission", () => {
  it("asks for permission only when recognition starts and denial leaves nothing behind", async () => {
    const native = new FakeNative();
    native.permission = "denied";
    const input = createSpeechSystemInput(native);
    const partials: string[] = [];
    const result = await input.listen({
      signal: new AbortController().signal,
      onPartial: (text) => partials.push(text),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("denial must fail");
    expect(result.error.code).toBe("permission");
    expect(native.requestPermissionCalls).toBe(1);
    expect(native.calls).toEqual(["getAvailability", "requestPermission"]);
    expect(native.active).toEqual([]);
    expect(partials).toEqual([]);
    expect(native.listenerCount()).toBe(0);
  });

  it("treats not-determined permission as available until the prompt", async () => {
    const native = new FakeNative();
    native.permission = "notDetermined";
    const input = createSpeechSystemInput(native);
    native.permission = "granted"; // the simulated system prompt is accepted
    const controller = new AbortController();
    const listening = input.listen({ signal: controller.signal });
    await flush();
    controller.abort();
    const result = await listening;
    expect(result).toEqual({ ok: true, value: "hello world" });
  });

  it("finalizes the capture when the listening cap elapses", async () => {
    const native = new FakeNative();
    const input = createSpeechSystemInput(native);
    const result = await input.listen({
      signal: new AbortController().signal,
      maxListeningMs: 20,
    });
    expect(result).toEqual({ ok: true, value: "hello world" });
    expect(native.calls.some((call) => call.startsWith("stop:"))).toBe(true);
  });
});

describe("dictation locale and on-device policy", () => {
  it("rejects an unsupported locale before capture starts", async () => {
    const native = new FakeNative();
    const input = createSpeechSystemInput(native);
    const result = await input.listen({
      locale: "xx-XX",
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("locale must be rejected");
    expect(result.error.code).toBe("unsupported");
    expect(native.calls.some((call) => call.startsWith("start:"))).toBe(false);
  });

  it("offline-only refuses network fallback before capture", async () => {
    const native = new FakeNative();
    native.onDeviceSupported = false;
    const input = createSpeechSystemInput(native, { requireOnDevice: true });
    const result = await input.listen({
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("offline-only must refuse");
    expect(result.error.code).toBe("unsupported");
    expect(native.calls.some((call) => call.startsWith("start:"))).toBe(false);
  });

  it("reports network-backed operation before any dictated text", async () => {
    const native = new FakeNative();
    native.onDeviceSupported = false;
    native.startResult = { ok: true, value: { locale: "en-US", onDevice: false } };
    const input = createSpeechSystemInput(native);
    const controller = new AbortController();
    const disclosures: (boolean | null)[] = [];
    const listening = input.listen({
      signal: controller.signal,
      onPartial: () => disclosures.push(input.operationInfo()?.onDevice ?? null),
    });
    await flush();
    native.emit("dictation-1", "he");
    controller.abort();
    await listening;
    expect(disclosures).toEqual([false]);
  });
});

describe("dictation session flow", () => {
  it("delivers partials in order and returns the final text on stop", async () => {
    const native = new FakeNative();
    const input = createSpeechSystemInput(native);
    const controller = new AbortController();
    const partials: string[] = [];
    const listening = input.listen({
      signal: controller.signal,
      onPartial: (text) => partials.push(text),
    });
    await flush();
    native.emit("dictation-1", "he");
    native.emit("dictation-1", "hello wor");
    controller.abort();
    const result = await listening;
    expect(partials).toEqual(["he", "hello wor"]);
    expect(result).toEqual({ ok: true, value: "hello world" });
    expect(native.active).toEqual([]);
    expect(native.listenerCount()).toBe(0);
    expect(input.operationInfo()).toEqual({ locale: "en-US", onDevice: true });
  });

  it("cancel discards the temporary recognition instead of finalizing", async () => {
    const native = new FakeNative();
    const input = createSpeechSystemInput(native);
    const controller = new AbortController();
    const partials: string[] = [];
    const listening = input.listen({
      signal: controller.signal,
      onPartial: (text) => partials.push(text),
    });
    await flush();
    native.emit("dictation-1", "draft only");
    await input.cancel();
    native.emit("dictation-1", "late fragment");
    controller.abort();
    const result = await listening;
    expect(partials).toEqual(["draft only"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("cancel must discard");
    expect(result.error.code).toBe("canceled");
    expect(native.calls).toContain("cancel:dictation-1");
    expect(native.calls.some((call) => call.startsWith("stop:"))).toBe(false);
  });

  it("ignores stale callbacks from canceled, foreign or finished requests", async () => {
    const native = new FakeNative();
    const input = createSpeechSystemInput(native);
    const controller = new AbortController();
    const partials: string[] = [];
    const listening = input.listen({
      signal: controller.signal,
      onPartial: (text) => partials.push(text),
    });
    await flush();
    native.emit("dictation-44", "other session");
    native.emit("dictation-1", "mine");
    controller.abort();
    await listening;
    native.emit("dictation-1", "after finish");
    expect(partials).toEqual(["mine"]);
  });

  it("pre-empts an older capture and cleans it up when a new one starts", async () => {
    const native = new FakeNative();
    const input = createSpeechSystemInput(native);
    const first = new AbortController();
    const firstListening = input.listen({ signal: first.signal });
    await flush();
    const second = new AbortController();
    const secondListening = input.listen({ signal: second.signal });
    await flush();
    expect(native.calls).toContain("cancel:dictation-1");
    expect(native.active).toEqual(["dictation-2"]);
    second.abort();
    await secondListening;
    first.abort();
    const firstResult = await firstListening;
    expect(firstResult.ok).toBe(false);
    if (firstResult.ok) throw new Error("pre-empted capture must cancel");
    expect(firstResult.error.code).toBe("canceled");
    expect(native.listenerCount()).toBe(0);
  });

  it("dispose settles an active capture and releases listeners", async () => {
    const native = new FakeNative();
    const input = createSpeechSystemInput(native);
    const controller = new AbortController();
    const listening = input.listen({ signal: controller.signal });
    await flush();
    if (!input.dispose) throw new Error("facade must expose dispose");
    await input.dispose();
    controller.abort();
    const result = await listening;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("disposed capture must cancel");
    expect(native.active).toEqual([]);
    expect(native.listenerCount()).toBe(0);
  });
});
