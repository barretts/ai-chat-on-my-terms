import assert from "node:assert/strict";
import test from "node:test";
import {
  runVoiceAction,
  stopVoiceSession,
  type VoicePorts,
} from "../src/index.ts";

const model = { modelClass: "q4-small", persona: { name: "Guide", instruction: "brief" } };

function portsDouble(permission: "granted" | "denied" | "undetermined") {
  const log: string[] = [];
  const ports: VoicePorts = {
    search: {
      async open(query) {
        log.push(`search:${query}`);
      },
    },
    session: {
      async start(options) {
        log.push(`session:${options.mode}:${options.model.modelClass}`);
        return { sessionId: "s-1" };
      },
      async end(sessionId) {
        log.push(`session-end:${sessionId}`);
      },
    },
    call: {
      async start(m) {
        log.push(`call:${m.modelClass}`);
        return { callId: "c-1" };
      },
      async end(callId) {
        log.push(`call-end:${callId}`);
      },
    },
    mic: {
      permission: () => permission,
      async open() {
        log.push("mic-open");
      },
      async close() {
        log.push("mic-close");
      },
    },
  };
  return { ports, log };
}

test("four actions activate the right screens/sessions (smoke 1)", async () => {
  const { ports, log } = portsDouble("granted");
  const search = await runVoiceAction(
    { action: "search", query: "best ramen near me" },
    { ports, model },
  );
  assert.deepEqual(search, {
    ok: true,
    kind: "search-opened",
    query: "best ramen near me",
  });
  const ask = await runVoiceAction(
    { action: "ask-on-device", query: "hi" },
    { ports, model },
  );
  assert.equal(ask.ok === true && ask.kind === "session" && ask.mode === "text", true);
  const voice = await runVoiceAction({ action: "voice-chat" }, { ports, model });
  assert.equal(voice.ok === true && voice.kind === "session" && voice.mode === "voice", true);
  const call = await runVoiceAction({ action: "call" }, { ports, model });
  assert.equal(call.ok === true && call.kind === "call", true);
  assert.deepEqual(log, [
    "search:best ramen near me",
    "session:text:q4-small",
    "mic-open",
    "session:voice:q4-small",
    "mic-open",
    "call:q4-small",
  ]);
  if (call.ok && call.kind === "call") {
    await call.stop();
    assert.deepEqual(log.slice(6), ["call-end:c-1", "mic-close"]);
  }
});

test("stop cleans the mic on voice chat too (smoke 1)", async () => {
  const { ports, log } = portsDouble("granted");
  const voice = await runVoiceAction({ action: "voice-chat" }, { ports, model });
  assert.equal(voice.ok, true);
  await stopVoiceSession("s-1", ports);
  assert.deepEqual(log, ["mic-open", "session:voice:q4-small", "session-end:s-1", "mic-close"]);
});

test("model/persona stay explicit; missing model refuses (step 3)", async () => {
  const { ports, log } = portsDouble("granted");
  const bad = await runVoiceAction({ action: "voice-chat" }, {
    ports,
    model: { modelClass: "" } as never,
  });
  assert.deepEqual(bad, { ok: false, reason: "invalid-input" });
  const smuggled = await runVoiceAction(
    { action: "search", query: "hi", providerUrl: "https://x" },
    { ports, model },
  );
  assert.deepEqual(smuggled, { ok: false, reason: "invalid-input" });
  assert.deepEqual(log, []);
});

test("microphone permission gates voice actions", async () => {
  for (const permission of ["denied", "undetermined"] as const) {
    const { ports, log } = portsDouble(permission);
    const voice = await runVoiceAction({ action: "voice-chat" }, { ports, model });
    const call = await runVoiceAction({ action: "call" }, { ports, model });
    assert.deepEqual(voice, {
      ok: false,
      reason: permission === "denied" ? "mic-denied" : "mic-unavailable",
    });
    assert.deepEqual(call, voice);
    assert.deepEqual(log, []);
  }
});
