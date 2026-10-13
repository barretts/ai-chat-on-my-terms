import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { audioFailure, type AudioResult } from "@locallab/audio-session";
import type {
  DictationInputPort,
  DictationListenOptions,
} from "@locallab/speech-system";
import type { OfflineSpeech, SpeechState } from "../../platform/speech/types";
import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import {
  DictationController,
  SQLiteDictationPreferenceStore,
  resolveDictationPreferences,
} from "./dictation";
import { dictationInput as webDictationInput } from "../audio/dictation-input.web";

interface Capture {
  signal: AbortSignal;
  onPartial?: (text: string) => void;
  settle: (result: AudioResult<string>) => void;
  canceled: boolean;
}

function fakeSpeech(): OfflineSpeech {
  const state: SpeechState = {
    phase: "idle",
    selectedVoiceId: "af_heart",
    installedModelIds: ["kokoro-v1"],
    message: "",
    progress: null,
    audioUri: null,
    rate: 0.9,
  };
  return {
    snapshot: () => state,
    subscribe: () => () => {},
    refresh: async () => {},
    selectVoice: async () => {},
    setRate: async () => {},
    install: async () => {},
    remove: async () => {},
    speak: async () => {},
    stop: async () => {},
  };
}

function fakeInput(behaviour: "final" | "permission-denied" = "final") {
  const captures: Capture[] = [];
  let cancels = 0;
  let info: { locale: string; onDevice: boolean } | null = null;
  const input: DictationInputPort = {
    async getAvailability() {
      return { ok: true, value: "ready" };
    },
    async getLocales() {
      return { ok: true, value: ["en-US", "fr-FR"] };
    },
    async listen(options: DictationListenOptions & { signal?: AbortSignal }) {
      if (behaviour === "permission-denied")
        return audioFailure(
          "permission",
          "Allow microphone and speech recognition in Settings, then tap Dictate again.",
          true,
        );
      const pending = Promise.withResolvers<AudioResult<string>>();
      const captured: Capture = {
        signal: options.signal ?? new AbortController().signal,
        // The session coordinator hands the wrapped partial callback here.
        onPartial: options.onPartial,
        canceled: false,
        settle: pending.resolve,
      };
      captures.push(captured);
      // Disclosure arrives before any text, matching the facade.
      info = { locale: options.locale ?? "en-US", onDevice: true };
      captured.signal.addEventListener(
        "abort",
        () => {
          if (captured.canceled) return;
          captured.onPartial?.("half of the sentence");
          pending.resolve({ ok: true, value: "final transcript" });
        },
        { once: true },
      );
      return pending.promise;
    },
    async cancel() {
      cancels += 1;
      const captured = captures.pop();
      if (captured) {
        captured.canceled = true;
        captured.settle({
          ok: false,
          error: {
            code: "canceled",
            message: "Recognition was canceled.",
            recoverable: true,
          },
        });
      }
    },
    operationInfo: () => info,
  };
  return {
    input,
    captureAt: (index: number) => captures[index],
    cancelCount: () => cancels,
  };
}

async function flushMicrotasks() {
  for (let round = 0; round < 8; round += 1) await Promise.resolve();
}

it("stop finalizes the capture once with disclosed locale and on-device status", async () => {
  const { input } = fakeInput();
  const controller = new DictationController(input, fakeSpeech());
  const partials: string[] = [];
  const run = controller.start({ onPartial: (text) => partials.push(text) }, "");
  await flushMicrotasks();
  controller.stop();
  const outcome = await run;
  expect(outcome).toEqual({
    status: "final",
    text: "final transcript",
    locale: "en-US",
    onDevice: true,
  });
  expect(partials).toEqual(["half of the sentence"]);
});

it("cancel discards the capture and tells the recognizer to discard the result", async () => {
  const { input, cancelCount } = fakeInput();
  const controller = new DictationController(input, fakeSpeech());
  const run = controller.start({ onPartial: () => {} }, "");
  await flushMicrotasks();
  controller.cancel();
  const outcome = await run;
  expect(outcome).toEqual({ status: "canceled" });
  expect(cancelCount()).toBe(1);
  // A second cancel with no active capture is inert.
  controller.cancel();
  expect(cancelCount()).toBe(1);
});

it("a newer dictation pre-empts the older capture and delivers one outcome each", async () => {
  const { input, captureAt, cancelCount } = fakeInput();
  const controller = new DictationController(input, fakeSpeech());
  const firstPartials: string[] = [];
  const secondPartials: string[] = [];
  const first = controller.start(
    { onPartial: (text) => firstPartials.push(text) },
    "",
  );
  await flushMicrotasks();
  const staleCapture = captureAt(0);
  const second = controller.start(
    { onPartial: (text) => secondPartials.push(text) },
    "fr-FR",
  );
  await flushMicrotasks();
  expect(await first).toEqual({ status: "canceled" });
  expect(cancelCount()).toBe(1);
  // Late partials from the superseded capture never reach either handler.
  staleCapture.onPartial?.("stale words");
  expect(firstPartials).toEqual([]);
  expect(secondPartials).toEqual([]);
  controller.stop();
  const secondOutcome = await second;
  expect(secondOutcome.status === "final" && secondOutcome.text).toBe(
    "final transcript",
  );
  expect(secondOutcome.status === "final" && secondOutcome.locale).toBe(
    "fr-FR",
  );
  expect(firstPartials).toEqual([]);
});

it("surfaces permission failures with honest recovery guidance", async () => {
  const { input } = fakeInput("permission-denied");
  const controller = new DictationController(input, fakeSpeech());
  const outcome = await controller.start({ onPartial: () => {} }, "");
  expect(outcome.status === "error" && outcome.code).toBe("permission");
  expect(
    outcome.status === "error" &&
      outcome.message.includes("Allow microphone and speech recognition"),
  ).toBe(true);
});

it("the web stub reports unavailability without ever capturing", async () => {
  const controller = new DictationController(webDictationInput, fakeSpeech());
  const outcome = await controller.start({ onPartial: () => {} }, "");
  expect(outcome.status === "error" && outcome.code).toBe("unavailable");
  expect(
    outcome.status === "error" &&
      outcome.message.includes("browsers do not expose"),
  ).toBe(true);
});

it("after dispose no capture can start", async () => {
  const { input } = fakeInput();
  const controller = new DictationController(input, fakeSpeech());
  await controller.dispose();
  const outcome = await controller.start({ onPartial: () => {} }, "");
  expect(outcome.status === "error" && outcome.code).toBe("draining");
});

it("dictation locale and autosend survive reopening through SQLite", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const port: SQLiteDatabasePort = {
      execAsync: async (sql) => {
        database.exec(sql);
      },
      runAsync: async (sql, ...values) => database.prepare(sql).run(...values),
      getFirstAsync: async <T,>(
        sql: string,
        ...values: (string | number | null | Uint8Array)[]
      ) => (database.prepare(sql).get(...values) as T) ?? null,
      getAllAsync: async <T,>(
        sql: string,
        ...values: (string | number | null | Uint8Array)[]
      ) => (database.prepare(sql).all(...values) as T[]),
      withTransactionAsync: async (work) => {
        await work();
      },
    };
    const store = new SQLiteDictationPreferenceStore(port);
    expect(await store.load()).toBe(null);
    await store.save({ locale: "fr-FR", autosend: true });
    expect(await new SQLiteDictationPreferenceStore(port).load()).toEqual({
      locale: "fr-FR",
      autosend: true,
    });
    await store.save({ locale: "", autosend: false });
    expect(await new SQLiteDictationPreferenceStore(port).load()).toEqual({
      locale: "",
      autosend: false,
    });
  } finally {
    database.close();
  }
});

it("invalid stored dictation preferences fall back to system locale and manual send", () => {
  expect(resolveDictationPreferences(null)).toEqual({
    locale: "",
    autosend: false,
  });
  expect(resolveDictationPreferences({ locale: 7, autosend: "yes" })).toEqual({
    locale: "",
    autosend: false,
  });
});
