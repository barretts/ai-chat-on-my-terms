import type { PersonaRecord } from "@locallab/personas-library";
import {
  effectiveVoiceControls,
  VOICE_ENGINE_CAPABILITIES,
  type VoiceEngineId,
  type VoicePreferences,
} from "./settings";

/**
 * Per-Persona voice settings live in the Persona profile (VO-06), alongside
 * the `speechVoiceId`/`speechRate` keys the manual read-aloud action already
 * honors. `speechEngine` and `speechConnectionId` extend the same idea to
 * cloud voices.
 */
export interface PersonaVoice {
  readonly engine: VoiceEngineId | undefined;
  readonly voiceId: string | undefined;
  readonly connectionId: string | undefined;
  readonly rate: number | undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "default" ? trimmed : undefined;
}

function asEngineId(value: unknown): VoiceEngineId | undefined {
  if (typeof value !== "string") return undefined;
  return Object.hasOwn(VOICE_ENGINE_CAPABILITIES, value)
    ? (value as VoiceEngineId)
    : undefined;
}

export function parsePersonaVoice(
  profile: PersonaRecord["profile"] | undefined,
): PersonaVoice {
  if (!profile)
    return {
      engine: undefined,
      voiceId: undefined,
      connectionId: undefined,
      rate: undefined,
    };
  const rate = profile["speechRate"];
  const voiceId = asTrimmedString(profile["speechVoice"]);
  return {
    engine: asEngineId(profile["speechEngine"]),
    voiceId:
      voiceId ??
      asTrimmedString(profile["speechVoiceId"])?.slice(0, 256) ??
      undefined,
    connectionId: asTrimmedString(profile["speechConnectionId"])?.slice(
      0,
      128,
    ),
    rate: typeof rate === "number" && Number.isFinite(rate) ? rate : undefined,
  };
}

/** `undefined` leaves a key untouched; `null` clears it. */
export interface PersonaVoicePatchInput {
  readonly engine?: VoiceEngineId | null;
  readonly voiceId?: string | null;
  readonly connectionId?: string | null;
  readonly rate?: number | null;
}

/** Profile patch merging into `persona.profile` via PersonaLibrary.update. */
export function personaVoicePatch(
  voice: PersonaVoicePatchInput,
): Record<string, string | number | null> {
  const patch: Record<string, string | number | null> = {};
  if (voice.engine !== undefined) patch["speechEngine"] = voice.engine;
  if (voice.voiceId !== undefined) patch["speechVoice"] = voice.voiceId;
  if (voice.connectionId !== undefined)
    patch["speechConnectionId"] = voice.connectionId;
  if (voice.rate !== undefined) patch["speechRate"] = voice.rate;
  return patch;
}

export type ReadAloudTarget =
  | {
      readonly kind: "offline";
      readonly voiceId?: string;
      readonly rate: number;
    }
  | {
      readonly kind: "system";
      readonly rate: number;
      readonly pitch: number;
      readonly language?: string;
    }
  | {
      readonly kind: "cloud";
      readonly provider: "elevenlabs" | "xai";
      readonly connectionId: string;
      readonly voiceId: string;
      readonly speed: number;
    }
  | { readonly kind: "unbound"; readonly message: string };

/**
 * Chooses the read-aloud engine for one reply: the Persona binding wins over
 * the app default, and a cloud Persona without a stored voice and API
 * connection is reported honestly instead of silently switching voices.
 */
export function resolveReadAloudTarget(
  prefs: VoicePreferences,
  persona: PersonaRecord | undefined,
): ReadAloudTarget {
  const voice = parsePersonaVoice(persona?.profile);
  const engine = voice.engine ?? prefs.engine;
  const capabilities = VOICE_ENGINE_CAPABILITIES[engine];
  const controls = effectiveVoiceControls(
    { ...prefs, ...(voice.rate === undefined ? {} : { rate: voice.rate }) },
    engine,
  );
  const [rateMin, rateMax] = capabilities.rateRange;
  const rate =
    controls.rate === undefined
      ? 1
      : Math.min(rateMax, Math.max(rateMin, controls.rate));
  const voiceId = (voice.voiceId ?? prefs.voiceId).trim() || undefined;
  if (engine === "offline")
    return { kind: "offline", rate, ...(voiceId ? { voiceId } : {}) };
  if (engine === "system")
    return {
      kind: "system",
      rate,
      pitch: controls.pitch ?? 1,
      ...(prefs.locale ? { language: prefs.locale } : {}),
    };
  if (!voice.connectionId || !voiceId)
    return {
      kind: "unbound",
      message:
        `${capabilities.label} needs this Persona's voice and API` +
        " connection set in Voice settings before its answers can be read aloud.",
    };
  return {
    kind: "cloud",
    provider: engine,
    connectionId: voice.connectionId,
    voiceId,
    speed: rate,
  };
}
