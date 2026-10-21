import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRequest } from "@locallab/contracts/run-events";
import {
  createGrammarGuard,
  grammarGuardKey,
  withGrammarGuard,
  GRAMMAR_GUARD_FILE_PREFIXES,
  type GrammarGuardStorage,
} from "../src/index.js";

function memoryStorage(options: { failWrites?: boolean } = {}): {
  storage: GrammarGuardStorage;
  files: Map<string, unknown>;
  listCalls: string[];
} {
  const files = new Map<string, unknown>();
  const listCalls: string[] = [];
  return {
    files,
    listCalls,
    storage: {
      async read<T>(name: string) {
        const value = files.get(name);
        if (value === undefined) return undefined;
        // Mirror the expo implementation: corrupt content reads as missing.
        if (typeof value === "string") {
          try {
            return JSON.parse(value) as T;
          } catch {
            return undefined;
          }
        }
        return value as T;
      },
      async write(name: string, value: unknown) {
        if (options.failWrites) throw new Error("disk full");
        files.set(name, value);
      },
      async remove(name: string) {
        files.delete(name);
      },
      async list(prefix: string) {
        listCalls.push(prefix);
        return [...files.keys()].filter((name) => name.startsWith(prefix));
      },
    },
  };
}

const MODEL = "blob:01a15b4d-d661-7466-bcf7-139c173a8b7f";
const VERSION = "llama-rn-0.12.4";

const jsonRequest = (json: boolean): RunRequest => ({
  runId: "run-00000000-0000-4000-8000-000000000001",
  conversationId: "conversation-00000000-0000-4000-8000-000000000001",
  messageId: "message-00000000-0000-4000-8000-000000000001",
  providerConnectionId: "connection-00000000-0000-4000-8000-000000000001",
  modelId: MODEL,
  context: [{ kind: "user", value: "select a topic" }],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json,
});

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of iterable) seen.push(value);
  return seen;
}

function inner(events: string[], seen: RunRequest[]) {
  return (request: RunRequest) =>
    (async function* () {
      seen.push(request);
      for (const event of events) yield event;
    })();
}

test("non-json requests pass through untouched with zero storage traffic", async () => {
  const { storage, files } = memoryStorage();
  const guard = createGrammarGuard({ storage, guardVersion: VERSION });
  const seen: RunRequest[] = [];
  const events = await drain(
    withGrammarGuard(guard, jsonRequest(false), inner(["a"], seen)),
  );
  assert.deepEqual(events, ["a"]);
  assert.deepEqual(seen, [jsonRequest(false)]);
  assert.equal(files.size, 0);
});

test("json run writes the probe before the native call and clears it on clean finish", async () => {
  const { storage, files } = memoryStorage();
  const guard = createGrammarGuard({ storage, guardVersion: VERSION });
  const seen: RunRequest[] = [];
  const probeDuringRun: boolean[] = [];
  const events = await drain(
    withGrammarGuard(guard, jsonRequest(true), (request) => {
      seen.push(request);
      probeDuringRun.push(
        [...files.keys()].some((name) =>
          name.startsWith(GRAMMAR_GUARD_FILE_PREFIXES.probe),
        ),
      );
      return (async function* () {
        yield "done";
      })();
    }),
  );
  assert.deepEqual(events, ["done"]);
  assert.equal(seen[0]?.json, true, "probe present => json preserved");
  assert.deepEqual(probeDuringRun, [true], "marker durable before native call");
  assert.equal(files.size, 0, "clean finish clears the probe");
});

test("probe surviving a restart quarantines the model on the next launch", async () => {
  const { storage, files } = memoryStorage();
  const crashed = createGrammarGuard({ storage, guardVersion: VERSION });
  // First launch: probe written, then the process aborts mid-run (no finally).
  assert.equal(await crashed.beginProbe(MODEL, "run-crash"), true);
  assert.equal(await crashed.beginProbe(MODEL, "run-crash-2"), true);
  // Second launch: fresh guard over the same durable storage.
  const rebooted = createGrammarGuard({ storage, guardVersion: VERSION });
  await rebooted.ready();
  assert.equal(rebooted.isQuarantined(MODEL), true);
  const entries = rebooted.quarantined();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.modelId, MODEL);
  assert.match(entries[0]?.reason ?? "", /common_sampler_init/);
  const key = grammarGuardKey(MODEL, VERSION);
  assert.equal(
    files.has(`${GRAMMAR_GUARD_FILE_PREFIXES.quarantine}${key}.json`),
    true,
    "quarantine is durable",
  );
  assert.equal(
    [...files.keys()].some((name) =>
      name.startsWith(GRAMMAR_GUARD_FILE_PREFIXES.probe),
    ),
    false,
    "crash markers consumed",
  );
  // JSON requests now downgrade to text without ever touching grammar again.
  const seen: RunRequest[] = [];
  await drain(
    withGrammarGuard(rebooted, jsonRequest(true), inner(["t"], seen)),
  );
  assert.equal(seen[0]?.json, false, "quarantined => grammar never requested");
  // Quarantine survives yet another restart.
  const third = createGrammarGuard({ storage, guardVersion: VERSION });
  await third.ready();
  assert.equal(third.isQuarantined(MODEL), true);
  assert.equal(third.quarantined().length, 1, "no duplicate entries");
});

test("marker write failure fails closed: run continues in text mode", async () => {
  const { storage } = memoryStorage({ failWrites: true });
  const guard = createGrammarGuard({ storage, guardVersion: VERSION });
  const seen: RunRequest[] = [];
  await drain(withGrammarGuard(guard, jsonRequest(true), inner(["t"], seen)));
  assert.equal(seen[0]?.json, false);
});

test("explicit reset clears quarantine files and re-enables json", async () => {
  const { storage, files } = memoryStorage();
  const first = createGrammarGuard({ storage, guardVersion: VERSION });
  await first.beginProbe(MODEL, "run-crash");
  const rebooted = createGrammarGuard({ storage, guardVersion: VERSION });
  await rebooted.ready();
  assert.equal(rebooted.isQuarantined(MODEL), true);
  await rebooted.resetQuarantine(MODEL);
  assert.equal(rebooted.isQuarantined(MODEL), false);
  assert.equal(files.size, 0, "quarantine + probe files cleared");
  const seen: RunRequest[] = [];
  await drain(
    withGrammarGuard(rebooted, jsonRequest(true), inner(["j"], seen)),
  );
  assert.equal(seen[0]?.json, true);
});

test("reconcile removes corrupt markers and ready() runs once", async () => {
  const { storage, files, listCalls } = memoryStorage();
  files.set(
    `${GRAMMAR_GUARD_FILE_PREFIXES.probe}blob-corrupt.llama-rn-0.12.4.run-1.json`,
    "{not json",
  );
  files.set(
    `${GRAMMAR_GUARD_FILE_PREFIXES.quarantine}blob-corrupt.llama-rn-0.12.4.json`,
    "{not json",
  );
  const guard = createGrammarGuard({ storage, guardVersion: VERSION });
  await Promise.all([guard.ready(), guard.ready()]);
  assert.equal(listCalls.length, 2, "one quarantine + one probe list, once");
  assert.equal(files.size, 0, "corrupt files pruned");
});

test("concurrent json runs of one model each carry their own probe", async () => {
  const { storage, files } = memoryStorage();
  const guard = createGrammarGuard({ storage, guardVersion: VERSION });
  assert.equal(await guard.beginProbe(MODEL, "run-a"), true);
  assert.equal(await guard.beginProbe(MODEL, "run-b"), true);
  const probes = [...files.keys()].filter((name) =>
    name.startsWith(GRAMMAR_GUARD_FILE_PREFIXES.probe),
  );
  assert.equal(probes.length, 2);
  await guard.endProbe(MODEL, "run-a");
  const remaining = [...files.keys()].filter((name) =>
    name.startsWith(GRAMMAR_GUARD_FILE_PREFIXES.probe),
  );
  assert.deepEqual(
    remaining,
    probes.filter((name) => name.includes("run-b")),
  );
  await guard.endProbe(MODEL, "run-b");
  assert.equal(files.size, 0);
});

test("abandoned iteration still clears the probe (generator finally)", async () => {
  const { storage, files } = memoryStorage();
  const guard = createGrammarGuard({ storage, guardVersion: VERSION });
  const iterable = withGrammarGuard(guard, jsonRequest(true), () =>
    (async function* () {
      yield "first";
      yield "never-consumed";
    })(),
  );
  const iterator = iterable[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: "first", done: false });
  await iterator.return?.(undefined);
  assert.equal(
    files.size,
    0,
    "stop-mid-run must not quarantine a healthy model",
  );
});
