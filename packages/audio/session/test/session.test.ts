import { expect, it } from "vitest";
import {
  AudioSessionCoordinator,
  type AudioResult,
  type ListenOptions,
  type SpeechInputPort,
  type SpeechOutputPort,
} from "../src/index";

const flush = async () => {
  for (let tick = 0; tick < 6; tick++) await Promise.resolve();
};

interface StartedListen {
  signal: AbortSignal;
  resolve: (result: AudioResult<string>) => void;
  emitPartial: (text: string) => void;
}

function harness(options: { settleOnAbort?: boolean } = {}) {
  const settleOnAbort = options.settleOnAbort ?? true;
  const order: string[] = [];
  const listens: StartedListen[] = [];
  const input: SpeechInputPort = {
    getAvailability: async () => ({ ok: true, value: "ready" }),
    getLocales: async () => ({ ok: true, value: ["en-US"] }),
    listen: (options: ListenOptions) =>
      new Promise<AudioResult<string>>((resolve) => {
        order.push("listen-start");
        const entry: StartedListen = {
          signal: options.signal,
          resolve,
          emitPartial: (text) => options.onPartial?.(text),
        };
        listens.push(entry);
        options.signal.addEventListener("abort", () => {
          order.push("listen-end");
          if (settleOnAbort)
            resolve({
              ok: false,
              error: {
                code: "canceled",
                message: "canceled",
                recoverable: true,
              },
            });
        });
      }),
    dispose: async () => {
      order.push("input-dispose");
    },
  };
  let speaking = false;
  let finishPendingSpeak: (() => void) | null = null;
  const output: SpeechOutputPort & { finishSpeak: () => void } = {
    getAvailability: async () => ({ ok: true, value: "ready" }),
    isSpeaking: () => speaking,
    speak: (text: string) =>
      new Promise<AudioResult<void>>((resolve) => {
        order.push("speak:" + text);
        speaking = true;
        finishPendingSpeak = () => {
          speaking = false;
          order.push("speak-end");
          resolve({ ok: true, value: undefined });
        };
      }),
    stop: async () => {
      order.push("output-stop");
      speaking = false;
      finishPendingSpeak?.();
      return { ok: true, value: undefined };
    },
    dispose: async () => {
      order.push("output-dispose");
    },
    finishSpeak: () => finishPendingSpeak?.(),
  };
  const coordinator = new AudioSessionCoordinator(input, output);
  return { coordinator, order, listens, output };
}

it("closes capture before playback so output is never transcribed", async () => {
  const { coordinator, order, listens, output } = harness();
  const listening = coordinator.listen();
  await flush();
  const active = listens[0];
  if (!active) throw new Error("expected capture to have started");
  const speaking = coordinator.speak("device output", {});
  await flush();
  expect(order).toEqual(["listen-start", "listen-end", "speak:device output"]);
  expect(active.signal.aborted).toBe(true);
  const replaced = await listening;
  expect(replaced.ok).toBe(false);
  output.finishSpeak();
  expect(await speaking).toEqual({ ok: true, value: undefined });
  expect(coordinator.getPhase()).toBe("idle");
  // No capture was opened while the device was speaking.
  expect(listens).toHaveLength(1);
});

it("stops owned playback before opening capture", async () => {
  const { coordinator, order, listens } = harness();
  const speaking = coordinator.speak("reading aloud", {});
  await flush();
  const listening = coordinator.listen();
  await flush();
  expect(order).toEqual([
    "speak:reading aloud",
    "output-stop",
    "speak-end",
    "listen-start",
  ]);
  expect(listens).toHaveLength(1);
  const active = listens[0];
  if (!active) throw new Error("expected capture to have started");
  active.resolve({ ok: true, value: "hello" });
  expect(await listening).toEqual({ ok: true, value: "hello" });
  const previous = await speaking;
  expect(previous.ok).toBe(false);
  if (previous.ok) throw new Error("superseded playback must report cancel");
  expect(previous.error.code).toBe("canceled");
  expect(coordinator.getPhase()).toBe("idle");
});

it("drops partials from superseded turns", async () => {
  const { coordinator, listens } = harness();
  const partials: string[] = [];
  const first = coordinator.listen({
    onPartial: (text) => partials.push("1:" + text),
  });
  await flush();
  const older = listens[0];
  if (!older) throw new Error("expected first capture");
  older.emitPartial("he");
  const second = coordinator.listen({
    onPartial: (text) => partials.push("2:" + text),
  });
  await flush();
  const newer = listens[1];
  if (!newer) throw new Error("expected second capture");
  older.emitPartial("hello"); // superseded: must not reach the app
  newer.emitPartial("help");
  expect(partials).toEqual(["1:he", "2:help"]);
  newer.resolve({ ok: true, value: "help" });
  expect((await first).ok).toBe(false);
  expect(await second).toEqual({ ok: true, value: "help" });
});

it("repeated stop is safe and never restarts capture", async () => {
  const { coordinator, listens, output } = harness();
  expect((await coordinator.stop()).ok).toBe(true);
  const speaking = coordinator.speak("noise", {});
  await flush();
  output.finishSpeak();
  await speaking;
  for (let attempt = 0; attempt < 3; attempt++)
    expect((await coordinator.stop()).ok).toBe(true);
  expect(coordinator.getPhase()).toBe("idle");
  expect(listens).toHaveLength(0);
});

it("user cancellation only affects the owned capture", async () => {
  const { coordinator, listens } = harness();
  const controller = new AbortController();
  const canceled = coordinator.listen({ signal: controller.signal });
  await flush();
  const keepAlive = coordinator.listen();
  await flush();
  controller.abort();
  await flush();
  const first = await canceled;
  expect(first.ok).toBe(false);
  if (first.ok) throw new Error("must report cancellation");
  expect(first.error.code).toBe("canceled");
  const active = listens[1];
  if (!active) throw new Error("expected the newer capture to own the session");
  expect(active.signal.aborted).toBe(false);
  expect(coordinator.getPhase()).toBe("listening");
  active.resolve({ ok: true, value: "kept" });
  expect(await keepAlive).toEqual({ ok: true, value: "kept" });
});

it("walks the documented phase transitions", async () => {
  const { coordinator, listens } = harness();
  const phases: string[] = [];
  coordinator.subscribe(() => phases.push(coordinator.getPhase()));
  const listening = coordinator.listen();
  await flush();
  expect(coordinator.getPhase()).toBe("listening");
  expect(coordinator.beginGenerating().ok).toBe(false);
  const active = listens[0];
  if (!active) throw new Error("expected capture to have started");
  active.resolve({ ok: true, value: "final" });
  expect(await listening).toEqual({ ok: true, value: "final" });
  expect(phases).toEqual(["listening", "transcribing", "idle"]);
  expect(coordinator.beginGenerating().ok).toBe(true);
  expect(coordinator.getPhase()).toBe("generating");
  coordinator.endGenerating();
  coordinator.endGenerating(); // repeated is safe
  expect(coordinator.getPhase()).toBe("idle");
});

it("settles the phase when playback fails", async () => {
  const { coordinator, listens, output } = harness();
  output.speak = () =>
    Promise.resolve({
      ok: false,
      error: { code: "failed", message: "no voice pack", recoverable: true },
    });
  const result = await coordinator.speak("hello", {});
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("failure must surface");
  expect(result.error.message).toBe("no voice pack");
  expect(coordinator.getPhase()).toBe("idle");
  expect(listens).toHaveLength(0);
});

it("drains durable work before disposal and refuses new admission", async () => {
  const { coordinator, order, listens } = harness({ settleOnAbort: false });
  const listening = coordinator.listen();
  await flush();
  const active = listens[0];
  if (!active) throw new Error("expected capture to have started");
  const closing = coordinator.dispose();
  await flush();
  const refused = await coordinator.speak("too late", {});
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("admission must be refused");
  expect(refused.error.code).toBe("draining");
  expect((await coordinator.listen()).ok).toBe(false);
  // A canceled capture that has not settled yet keeps resources claimed.
  expect(order).toContain("listen-end");
  expect(order).not.toContain("input-dispose");
  expect(order).not.toContain("output-dispose");
  active.resolve({
    ok: false,
    error: { code: "canceled", message: "canceled", recoverable: true },
  });
  await closing;
  expect(order).toContain("input-dispose");
  expect(order).toContain("output-dispose");
  expect((await listening).ok).toBe(false);
  expect(coordinator.getPhase()).toBe("idle");
  await coordinator.dispose(); // repeated is safe
});
