/**
 * T117F (AU-08) — voice and search shortcut recipes: "Search", "Ask
 * On-Device", "Voice Chat" and "Call" shortcut actions. They bind to
 * the ports the app already declares (search, chat session, call,
 * microphone) — never to private internals — and the model/persona
 * used is always explicit (step 3). Stopping a voice action releases
 * the microphone (smoke).
 */
import { z } from "zod";

export const VOICE_ACTIONS = [
  "search",
  "ask-on-device",
  "voice-chat",
  "call",
] as const;
export type VoiceAction = (typeof VOICE_ACTIONS)[number];

export const VoiceActionPayloadSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("search"),
      query: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("ask-on-device"),
      query: z.string().min(1).max(2000),
    })
    .strict(),
  z.object({ action: z.literal("voice-chat") }).strict(),
  z.object({ action: z.literal("call") }).strict(),
]);
export type VoiceActionPayload = z.infer<typeof VoiceActionPayloadSchema>;

export const ModelSelectionSchema = z
  .object({
    modelClass: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    persona: z
      .object({
        name: z.string().min(1).max(64),
        instruction: z.string().min(1).max(2000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

/* ---------------- declared ports (step 2) ---------------- */

export interface VoicePorts {
  search: { open(query: string): Promise<void> };
  session: {
    start(options: {
      mode: "text" | "voice";
      model: ModelSelection;
    }): Promise<{ sessionId: string }>;
    end(sessionId: string): Promise<void>;
  };
  call: {
    start(model: ModelSelection): Promise<{ callId: string }>;
    end(callId: string): Promise<void>;
  };
  mic: {
    permission(): "granted" | "denied" | "undetermined";
    open(): Promise<void>;
    close(): Promise<void>;
  };
}

export type VoiceRunResult =
  | { ok: true; kind: "search-opened"; query: string }
  | { ok: true; kind: "session"; sessionId: string; mode: "text" | "voice" }
  | { ok: true; kind: "call"; callId: string; stop(): Promise<void> }
  | { ok: false; reason: "mic-denied" | "mic-unavailable" | "invalid-input" };

export async function runVoiceAction(
  payload: unknown,
  options: { ports: VoicePorts; model: ModelSelection },
): Promise<VoiceRunResult> {
  const parsedPayload = VoiceActionPayloadSchema.safeParse(payload);
  const parsedModel = ModelSelectionSchema.safeParse(options.model);
  if (!parsedPayload.success || !parsedModel.success)
    return { ok: false, reason: "invalid-input" };
  const ports = options.ports;
  const model = parsedModel.data;
  switch (parsedPayload.data.action) {
    case "search":
      await ports.search.open(parsedPayload.data.query);
      return { ok: true, kind: "search-opened", query: parsedPayload.data.query };
    case "ask-on-device": {
      const { sessionId } = await ports.session.start({ mode: "text", model });
      return { ok: true, kind: "session", sessionId, mode: "text" };
    }
    case "voice-chat": {
      const permission = ports.mic.permission();
      if (permission === "denied") return { ok: false, reason: "mic-denied" };
      if (permission !== "granted") return { ok: false, reason: "mic-unavailable" };
      await ports.mic.open();
      const { sessionId } = await ports.session.start({ mode: "voice", model });
      return { ok: true, kind: "session", sessionId, mode: "voice" };
    }
    case "call": {
      const permission = ports.mic.permission();
      if (permission === "denied") return { ok: false, reason: "mic-denied" };
      if (permission !== "granted") return { ok: false, reason: "mic-unavailable" };
      await ports.mic.open();
      const { callId } = await ports.call.start(model);
      return {
        ok: true,
        kind: "call",
        callId,
        async stop() {
          await ports.call.end(callId);
          await ports.mic.close();
        },
      };
    }
  }
}

/** Voice-chat stop: ends the session and releases the mic (smoke 1). */
export async function stopVoiceSession(
  sessionId: string,
  ports: VoicePorts,
): Promise<void> {
  await ports.session.end(sessionId);
  await ports.mic.close();
}
