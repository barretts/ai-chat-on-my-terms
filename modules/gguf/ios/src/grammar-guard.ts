/**
 * Grammar-guard: auto-heal marker for per-model native JSON-grammar crashes.
 *
 * llama.rn 0.12.4 builds the JSON grammar inside `common_sampler_init` on a
 * worker thread with no exception handler; for vocabularies where the grammar
 * compiler throws (proven on device: HauhauCS Qwen3.5 2B Aggressive,
 * `docs/implementation/evidence/parity/t179/README.md`) the process dies via
 * `std::terminate` — no JS ever runs, so the catch must span process restarts:
 * a durable marker written BEFORE each native JSON request and removed when
 * the request reaches any terminal state in-process. A marker that survives
 * into the next launch is the crash record: the model is quarantined from
 * grammar mode and its JSON requests run as plain text (the engine's parser
 * tolerates unstructured replies). A model therefore crashes at most ONCE.
 * Reset is owner-explicit (`resetQuarantine`); a llama.rn version bump changes
 * `guardVersion` and resets quarantine automatically (new key namespace).
 * Fail-closed: when markers cannot be written the run drops JSON mode instead
 * of risking an unrecorded crash.
 */
import type { RunRequest } from "@locallab/contracts/run-events";

export interface GrammarQuarantineEntry {
  modelId: string;
  /** ISO timestamp of the launch that observed the surviving marker. */
  since: string;
  reason: string;
}

/** Durable namespaced key-value store (JSON files); implemented on-device with expo-file-system. */
export interface GrammarGuardStorage {
  /** Parsed value, or undefined when the name is missing or corrupt. */
  read<T = unknown>(name: string): Promise<T | undefined>;
  write(name: string, value: unknown): Promise<void>;
  remove(name: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export const GRAMMAR_GUARD_FILE_PREFIXES = {
  probe: "probe-",
  quarantine: "quarantine-",
} as const;

export const GRAMMAR_QUARANTINE_REASON =
  "Native JSON-grammar crash (llama.rn common_sampler_init abort). Topic selection uses text mode for this model.";

export function grammarGuardKey(modelId: string, guardVersion: string): string {
  return `${modelId.replace(/[^A-Za-z0-9_-]+/g, "-")}.${guardVersion}`;
}

export interface GrammarGuard {
  /** Load quarantine + harvest surviving probe markers; at-most-once, never throws. */
  ready(): Promise<void>;
  /** Meaningful only after ready(); the caller runs ready() first. */
  isQuarantined(modelId: string): boolean;
  quarantined(): readonly GrammarQuarantineEntry[];
  resetQuarantine(modelId: string): Promise<void>;
  /**
   * Write the probe marker for one JSON run. Returns false when the marker
   * could not be persisted — the caller MUST then drop JSON mode (fail closed).
   */
  beginProbe(modelId: string, runId: string): Promise<boolean>;
  /** Remove the probe marker once the run terminalized in-process. Best effort. */
  endProbe(modelId: string, runId: string): Promise<void>;
}

interface ProbeRecord {
  modelId: string;
  runId: string;
  key: string;
  startedAt: string;
}

function probeFileName(key: string, runId: string): string {
  return `${GRAMMAR_GUARD_FILE_PREFIXES.probe}${key}.${runId}.json`;
}

function quarantineFileName(key: string): string {
  return `${GRAMMAR_GUARD_FILE_PREFIXES.quarantine}${key}.json`;
}

export function createGrammarGuard(options: {
  storage: GrammarGuardStorage;
  /** Identity of the native stack whose grammar may crash (e.g. `llama-rn-0.12.4`). */
  guardVersion: string;
  log?: (message: string) => void;
}): GrammarGuard {
  const { storage, guardVersion, log = () => undefined } = options;
  const entries = new Map<string, GrammarQuarantineEntry>();
  let reconciled: Promise<void> | undefined;

  const reconcile = async (): Promise<void> => {
    for (const name of await storage.list(
      GRAMMAR_GUARD_FILE_PREFIXES.quarantine,
    )) {
      const entry = await storage.read<GrammarQuarantineEntry>(name);
      if (entry && typeof entry.modelId === "string" && entry.modelId !== "")
        entries.set(grammarGuardKey(entry.modelId, guardVersion), entry);
      else await storage.remove(name).catch(() => undefined);
    }
    for (const name of await storage.list(GRAMMAR_GUARD_FILE_PREFIXES.probe)) {
      const probe = await storage.read<ProbeRecord>(name);
      if (!probe || typeof probe.modelId !== "string" || probe.modelId === "") {
        await storage.remove(name).catch(() => undefined);
        continue;
      }
      const key = grammarGuardKey(probe.modelId, guardVersion);
      if (!entries.has(key)) {
        const entry: GrammarQuarantineEntry = {
          modelId: probe.modelId,
          since: new Date().toISOString(),
          reason: GRAMMAR_QUARANTINE_REASON,
        };
        try {
          await storage.write(quarantineFileName(key), entry);
          entries.set(key, entry);
          log(
            `JSON grammar mode quarantined for ${probe.modelId} after a native crash`,
          );
        } catch (error) {
          log(`quarantine persist failed: ${String(error)}`);
        }
      }
      await storage.remove(name).catch(() => undefined);
    }
  };

  return {
    ready() {
      reconciled ??= reconcile().catch((error: unknown) => {
        log(`grammar guard reconcile failed: ${String(error)}`);
      });
      return reconciled;
    },
    isQuarantined(modelId) {
      return entries.has(grammarGuardKey(modelId, guardVersion));
    },
    quarantined() {
      return Object.freeze([...entries.values()]);
    },
    async resetQuarantine(modelId) {
      const key = grammarGuardKey(modelId, guardVersion);
      entries.delete(key);
      await storage.remove(quarantineFileName(key)).catch(() => undefined);
      for (const name of await storage
        .list(`${GRAMMAR_GUARD_FILE_PREFIXES.probe}${key}.`)
        .catch(() => [] as string[]))
        await storage.remove(name).catch(() => undefined);
    },
    async beginProbe(modelId, runId) {
      const key = grammarGuardKey(modelId, guardVersion);
      const record: ProbeRecord = {
        modelId,
        runId,
        key,
        startedAt: new Date().toISOString(),
      };
      try {
        await storage.write(probeFileName(key, runId), record);
        return true;
      } catch (error) {
        log(`probe marker write failed: ${String(error)}`);
        return false;
      }
    },
    async endProbe(modelId, runId) {
      const key = grammarGuardKey(modelId, guardVersion);
      await storage
        .remove(probeFileName(key, runId))
        .catch((error: unknown) => {
          log(`probe marker clear failed: ${String(error)}`);
        });
    },
  };
}

/**
 * Wrap one inference port call with the grammar guard. Non-JSON requests pass
 * through untouched. JSON requests run text-only when the model is
 * quarantined or the marker could not be written, and the marker is always
 * removed in `finally` — a marker surviving to the next launch is therefore
 * the crash record (see file header).
 */
export async function* withGrammarGuard<TEvent>(
  guard: GrammarGuard,
  request: RunRequest,
  run: (request: RunRequest) => AsyncIterable<TEvent>,
): AsyncGenerator<TEvent, void, undefined> {
  if (request.json !== true) {
    yield* run(request);
    return;
  }
  await guard.ready();
  if (guard.isQuarantined(request.modelId)) {
    yield* run({ ...request, json: false });
    return;
  }
  if (!(await guard.beginProbe(request.modelId, request.runId))) {
    yield* run({ ...request, json: false });
    return;
  }
  try {
    yield* run(request);
  } finally {
    await guard.endProbe(request.modelId, request.runId);
  }
}
