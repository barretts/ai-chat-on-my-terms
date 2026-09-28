import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunRequest } from "@locallab/contracts/run-events";
import {
  ArenaEngine,
  SQLiteArenaStore,
  type ArenaContestant,
} from "../src/index.js";
import {
  binding,
  date,
  deferred,
  event,
  id,
  idSource,
  port,
  provider,
  ready,
  stopped,
} from "./helpers.js";

test("monotonic timing excludes preparation/download/load from decode and labels provider telemetry separately", async () => {
  let monotonic = 0;
  let wall = date().getTime();
  const { db, store } = await ready(":memory:", () => new Date(wall));
  const engine = new ArenaEngine(store, {
    now: () => new Date(wall),
    monotonicNow: () => monotonic,
    createId: idSource(),
  });
  try {
    let released = false;
    const stream = provider(async function* (request) {
      yield event(request, 0, { type: "RunStarted" });
      monotonic += 1000;
      wall -= 100_000; // Wall clock correction cannot make TTFT negative.
      yield event(request, 1, { type: "LoadProgress", fraction: 1 });
      monotonic += 300;
      yield event(request, 2, { type: "TextDelta", text: "abcd" });
      monotonic += 100;
      yield event(request, 3, { type: "TextDelta", text: "efgh" });
      yield event(request, 4, {
        type: "Usage",
        outputTokens: 8,
        inputTokens: 10,
      });
      monotonic += 100;
      yield event(request, 5, { type: "RunCompleted", finishReason: "stop" });
    });
    const handle = await engine.start({
      prompt: "Same prompt",
      contestants: [
        binding(1, stream, {
          prepare: async () => {
            monotonic += 5000;
            return {
              release() {
                released = true;
              },
            };
          },
        }),
      ],
    });
    const result = await handle.done;
    await handle.resourcesDrained;
    const contestant = result.contestants[0]!;
    assert.equal(contestant.text, "abcdefgh");
    assert.equal(contestant.timing.preparationMs, 5000);
    assert.equal(contestant.timing.ttftMs, 1300);
    assert.equal(contestant.timing.elapsedMs, 1500);
    assert.equal(contestant.timing.decodeMs, 200);
    assert.equal(
      contestant.timing.decodeTimingSource,
      "observed-output-interval",
    );
    assert.equal(contestant.timing.providerOutputTokens, 8);
    assert.equal(contestant.timing.reportedTokenCountPerSecond, 40);
    assert.equal(contestant.timing.providerReportedTokensPerSecond, null);
    assert.equal(contestant.timing.estimatedOutputTokens, 2);
    assert.equal(contestant.timing.estimatedTokensPerSecond, 10);
    assert.equal(released, true);
    assert.ok(contestant.revision.wallMs >= result.run.revision.wallMs);
    assert.ok(contestant.revision.counter > 0);

    const second = await engine.start({
      prompt: "Another prompt",
      contestants: [
        binding(1, stream, {
          readReportedMetrics: () => ({
            outputTokensPerSecond: 80,
            decodeDurationMs: 100,
          }),
        }),
      ],
    });
    const reported = (await second.done).contestants[0]!.timing;
    await second.resourcesDrained;
    assert.equal(reported.providerReportedTokensPerSecond, 80);
    assert.equal(reported.reportedTokenCountPerSecond, 80);
    assert.equal(reported.decodeTimingSource, "provider-reported");
    assert.equal(reported.estimatedTokensPerSecond, 20);
  } finally {
    await engine.close();
    db.close();
  }
});

test("four contestants start concurrently, receive one frozen snapshot, preserve binding and isolate failures", async () => {
  const { db, store } = await ready();
  const entered = deferred();
  const gate = deferred();
  const requests: RunRequest[] = [];
  const live: ArenaContestant[] = [];
  const parameters = { temperature: 0.2, nested: { top_p: 0.9 } };
  const context = [{ kind: "system", value: "Write concisely" }];
  const connection = {
    baseUrl: "https://original.example",
    headers: { authorization: "Bearer secret-only-in-memory" },
  };
  const engine = new ArenaEngine(store, {
    createId: idSource(),
    onUpdate(update) {
      live.push(update.contestant);
      assert.equal(Object.isFrozen(update.contestant), true);
    },
  });
  try {
    const contestants = [1, 2, 3, 4].map((number) =>
      binding(
        number,
        provider(async function* (request) {
          requests.push(request);
          if (requests.length === 4) entered.resolve();
          await gate.promise;
          assert.equal(Object.isFrozen(request), true);
          assert.equal(Object.isFrozen(request.context), true);
          assert.equal(Object.isFrozen(request.parameters.nested), true);
          yield event(request, 0, { type: "RunStarted" });
          if (number === 3)
            throw new Error("Authorization: Bearer DO-NOT-PERSIST");
          yield event(request, 1, {
            type: "TextDelta",
            text: `Answer ${number}`,
          });
          yield event(request, 1, {
            type: "TextDelta",
            text: "duplicate must disappear",
          });
          yield event(request, 2, { type: "RunCompleted" });
        }),
        { connection },
      ),
    );
    const handle = await engine.start({
      prompt: "Compare",
      context,
      parameters,
      contestants,
    });
    await entered.promise;
    parameters.temperature = 99;
    parameters.nested.top_p = 0;
    context[0]!.value = "Changed externally";
    connection.baseUrl = "https://changed.example";
    gate.resolve();
    const result = await handle.done;
    await handle.resourcesDrained;
    assert.deepEqual(
      result.contestants.map((item) => item.state),
      ["completed", "completed", "failed", "completed"],
    );
    assert.deepEqual(
      result.contestants.map((item) => item.text),
      ["Answer 1", "Answer 2", "", "Answer 4"],
    );
    assert.equal(result.run.snapshot.parameters.temperature, 0.2);
    assert.deepEqual(result.run.snapshot.parameters.nested, { top_p: 0.9 });
    for (const [index, request] of requests.entries()) {
      assert.equal(request.modelId, `fixture-${index + 1}`);
      assert.equal(request.providerConnectionId, id(101 + index));
      assert.equal(request.context, requests[0]!.context);
      assert.equal(request.parameters, requests[0]!.parameters);
      assert.deepEqual(request.context, [
        { kind: "system", value: "Write concisely" },
        { kind: "user", value: "Compare" },
      ]);
    }
    assert.ok(live.some((item) => item.text === "Answer 4"));
    assert.equal(JSON.stringify(result).includes("DO-NOT-PERSIST"), false);
    assert.equal(
      JSON.stringify(result).includes("secret-only-in-memory"),
      false,
    );
    assert.equal(JSON.stringify(result).includes("baseUrl"), false);
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS count FROM arena_contestants").get() as {
          count: number;
        }
      ).count,
      4,
    );
  } finally {
    gate.resolve();
    await engine.close();
    db.close();
  }
});

test("unknown requested capabilities fail independently and never receive tools", async () => {
  const { db, store } = await ready();
  let started = 0;
  const stream = async function* (request: RunRequest) {
    started++;
    yield event(request, 0, { type: "RunCompleted" });
  };
  const engine = new ArenaEngine(store, { createId: idSource() });
  try {
    const handle = await engine.start({
      prompt: "Use tools",
      permittedTools: ["weather"],
      contestants: [
        binding(1, provider(stream, { tools: "unknown" })),
        binding(2, provider(stream, { tools: "yes" })),
      ],
    });
    const result = await handle.done;
    await handle.resourcesDrained;
    assert.equal(started, 1);
    assert.equal(result.contestants[0]!.state, "failed");
    assert.equal(result.contestants[0]!.capabilities.tools, "unknown");
    assert.equal(result.contestants[0]!.error?.code, "unsupported");
    assert.equal(result.contestants[1]!.state, "completed");
  } finally {
    await engine.close();
    db.close();
  }
});

test("stop one contestant retains its partial output while siblings finish and leases release", async () => {
  const { db, store } = await ready();
  const partial = deferred();
  const sibling = deferred();
  const releases: number[] = [];
  const engine = new ArenaEngine(store, {
    createId: idSource(),
    onUpdate(update) {
      if (update.contestant.text === "Partial") partial.resolve();
    },
  });
  try {
    const handle = await engine.start({
      prompt: "Cancel one",
      contestants: [
        binding(
          1,
          provider(async function* (request, signal) {
            yield event(request, 0, { type: "TextDelta", text: "Partial" });
            await stopped(signal);
            yield event(request, 1, {
              type: "TextDelta",
              text: "Late forbidden",
            });
            yield event(request, 2, { type: "RunCompleted" });
          }),
          {
            prepare: async () => ({
              release() {
                releases.push(1);
              },
            }),
          },
        ),
        binding(
          2,
          provider(async function* (request) {
            await sibling.promise;
            yield event(request, 0, {
              type: "TextDelta",
              text: "Sibling answer",
            });
            yield event(request, 1, { type: "RunCompleted" });
          }),
          {
            prepare: async () => ({
              release() {
                releases.push(2);
              },
            }),
          },
        ),
      ],
    });
    await partial.promise;
    const contestantId = (await handle.read()).contestants[0]!.id;
    await handle.cancel(contestantId);
    const canceled = (await handle.read()).contestants[0]!;
    assert.equal(canceled.state, "canceled");
    assert.equal(canceled.text, "Partial");
    sibling.resolve();
    const result = await handle.done;
    await handle.resourcesDrained;
    assert.equal(result.run.state, "completed");
    assert.deepEqual(
      result.contestants.map((item) => item.state),
      ["canceled", "completed"],
    );
    assert.deepEqual(releases.sort(), [1, 2]);
  } finally {
    sibling.resolve();
    await engine.close();
    db.close();
  }
});

test("resource limits abort an oversized stream without consuming its tail", async () => {
  const { db, store } = await ready();
  let tail = false;
  let closed = false;
  const engine = new ArenaEngine(store, {
    createId: idSource(),
    maxOutputCharacters: 8,
  });
  try {
    const handle = await engine.start({
      prompt: "Bound output",
      contestants: [
        binding(
          1,
          provider(async function* (request) {
            try {
              yield event(request, 0, { type: "TextDelta", text: "123456789" });
              tail = true;
              yield event(request, 1, { type: "RunCompleted" });
            } finally {
              closed = true;
            }
          }),
        ),
      ],
    });
    const result = await handle.done;
    await handle.resourcesDrained;
    assert.equal(result.contestants[0]!.state, "failed");
    assert.equal(result.contestants[0]!.text, "12345678");
    assert.equal(result.contestants[0]!.outputTruncated, true);
    assert.equal(result.contestants[0]!.error?.code, "quota");
    assert.equal(tail, false);
    assert.equal(closed, true);
    await assert.rejects(
      engine.start({
        prompt: "x",
        contestants: Array.from({ length: 5 }, (_, index) =>
          binding(
            index,
            provider(async function* () {}),
          ),
        ),
      }),
      /one to four/,
    );
    await assert.rejects(
      engine.start({
        prompt: "x",
        parameters: { authorization: "Bearer raw" },
        contestants: [
          binding(
            1,
            provider(async function* () {}),
          ),
        ],
      }),
      /secrets/,
    );
    assert.equal((await store.list()).length, 1);
  } finally {
    await engine.close();
    db.close();
  }
});

test("uncooperative stop settles durable cancellation and keeps the model leased until it drains", async () => {
  const { db, store } = await ready();
  const entered = deferred();
  const gate = deferred();
  let released = false;
  const engine = new ArenaEngine(store, { createId: idSource() });
  try {
    const handle = await engine.start({
      prompt: "Stop",
      contestants: [
        binding(
          1,
          provider(async function* (request) {
            entered.resolve();
            await gate.promise;
            yield event(request, 0, { type: "TextDelta", text: "Too late" });
            yield event(request, 1, { type: "RunCompleted" });
          }),
          {
            prepare: async () => ({
              release() {
                released = true;
              },
            }),
          },
        ),
      ],
    });
    await entered.promise;
    await handle.cancel();
    assert.equal((await handle.done).run.state, "canceled");
    assert.equal(released, false);
    await assert.rejects(
      engine.start({
        prompt: "New",
        contestants: [
          binding(
            1,
            provider(async function* () {}),
          ),
        ],
      }),
      /drain/,
    );
    gate.resolve();
    await handle.resourcesDrained;
    assert.equal(released, true);
    assert.equal((await handle.read()).contestants[0]!.text, "");
  } finally {
    gate.resolve();
    await engine.close();
    db.close();
  }
});

test("file-backed results and interrupted contestants reopen without resending or losing legacy sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locallab-arena-"));
  const path = join(directory, "arena.sqlite");
  let db: DatabaseSync | undefined;
  try {
    const first = await ready(path);
    db = first.db;
    db.exec(
      "CREATE TABLE arena_sessions(id TEXT PRIMARY KEY, config_json TEXT); INSERT INTO arena_sessions VALUES ('legacy', '{\"preserve\":true}')",
    );
    const engine = new ArenaEngine(first.store, { createId: idSource() });
    const handle = await engine.start({
      prompt: "Persist",
      contestants: [
        binding(
          1,
          provider(async function* (request) {
            yield event(request, 0, {
              type: "TextDelta",
              text: "Durable answer",
            });
            yield event(request, 1, { type: "Usage", outputTokens: 4 });
            yield event(request, 2, { type: "RunCompleted" });
          }),
        ),
      ],
    });
    const completed = await handle.done;
    await handle.resourcesDrained;
    await engine.close();
    const interruptedRun = {
      ...completed.run,
      id: id(500),
      state: "running" as const,
      contestantIds: [id(501)],
      finishedAt: null,
      ...first.store.stamp(),
    };
    const interruptedContestant = {
      ...completed.contestants[0]!,
      id: id(501),
      arenaRunId: id(500),
      state: "running" as const,
      text: "Saved partial",
      finishedAt: null,
      ...first.store.stamp(),
    };
    await first.store.create(interruptedRun, [interruptedContestant]);
    db.close();
    db = new DatabaseSync(path);
    const reopened = new SQLiteArenaStore(port(db), {
      deviceId: id(999),
      now: () => new Date(date().getTime() - 1000),
    });
    await reopened.initialize();
    const restored = await reopened.read(handle.id);
    assert.deepEqual(restored, completed);
    const recover = new ArenaEngine(reopened);
    assert.deepEqual(await recover.recover(), [id(500)]);
    assert.deepEqual(await recover.recover(), []);
    const interrupted = await reopened.read(id(500));
    assert.equal(interrupted!.run.state, "interrupted");
    assert.equal(interrupted!.contestants[0]!.state, "interrupted");
    assert.equal(interrupted!.contestants[0]!.text, "Saved partial");
    assert.ok(
      interrupted!.contestants[0]!.revision.counter >
        interruptedContestant.revision.counter,
    );
    assert.equal(
      (
        db
          .prepare("SELECT config_json FROM arena_sessions WHERE id='legacy'")
          .get() as { config_json: string }
      ).config_json,
      '{"preserve":true}',
    );
    await recover.close();
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cross-run events and missing terminal events fail with bounded safe messages", async () => {
  const { db, store } = await ready();
  const engine = new ArenaEngine(store, { createId: idSource() });
  try {
    const handle = await engine.start({
      prompt: "Validate",
      contestants: [
        binding(
          1,
          provider(async function* (request) {
            yield {
              ...event(request, 0, { type: "TextDelta", text: "wrong stream" }),
              runId: id(777),
            };
          }),
        ),
        binding(
          2,
          provider(async function* (request) {
            yield event(request, 0, {
              type: "TextDelta",
              text: "Partial before EOF",
            });
          }),
        ),
        binding(
          3,
          provider(async function* (request) {
            yield event(request, 0, {
              type: "RunFailed",
              error: {
                code: "unauthorized",
                message: "Bearer secret-provider-body",
                recoverable: true,
              },
            });
          }),
        ),
      ],
    });
    const result = await handle.done;
    await handle.resourcesDrained;
    assert.deepEqual(
      result.contestants.map((item) => item.error?.code),
      ["malformed", "malformed", "unauthorized"],
    );
    assert.deepEqual(
      result.contestants.map((item) => item.text),
      ["", "Partial before EOF", ""],
    );
    assert.equal(
      JSON.stringify(result).includes("secret-provider-body"),
      false,
    );
  } finally {
    await engine.close();
    db.close();
  }
});

test("duplicate-event floods are bounded and embedded media/tools cannot bypass capability gates", async () => {
  const { db, store } = await ready();
  let started = 0;
  const engine = new ArenaEngine(store, {
    createId: idSource(),
    maxEventsPerContestant: 3,
  });
  try {
    const handle = await engine.start({
      prompt: "Bound duplicates",
      contestants: [
        binding(
          1,
          provider(async function* (request) {
            for (;;)
              yield event(request, 0, { type: "TextDelta", text: "once" });
          }),
        ),
      ],
    });
    const result = await handle.done;
    await handle.resourcesDrained;
    assert.equal(result.contestants[0]!.text, "once");
    assert.equal(result.contestants[0]!.error?.code, "quota");
    await assert.rejects(
      engine.start({
        prompt: "Tools",
        parameters: { tools: [{ function: { name: "weather" } }] },
        contestants: [
          binding(
            1,
            provider(async function* () {}),
          ),
        ],
      }),
      /explicit permitted/,
    );
    const media = await engine.start({
      prompt: "Describe",
      context: [
        {
          kind: "user",
          value: {
            content: [
              { type: "input_image", image_url: "data:image/png;base64,YQ==" },
            ],
          },
        },
      ],
      contestants: [
        binding(
          1,
          provider(async function* (request) {
            started++;
            yield event(request, 0, { type: "RunCompleted" });
          }),
        ),
      ],
    });
    assert.equal((await media.done).contestants[0]!.error?.code, "unsupported");
    await media.resourcesDrained;
    assert.equal(started, 0);
  } finally {
    await engine.close();
    db.close();
  }
});

test(
  "timeout persists a failure before an uncooperative provider finishes and leaves siblings intact",
  { timeout: 3000 },
  async () => {
    const { db, store } = await ready();
    const gate = deferred();
    let released = false;
    const engine = new ArenaEngine(store, {
      createId: idSource(),
      maxRunMs: 20,
    });
    try {
      const handle = await engine.start({
        prompt: "Timeout",
        contestants: [
          binding(
            1,
            provider(async function* (request) {
              await gate.promise;
              yield event(request, 0, { type: "RunCompleted" });
            }),
            {
              prepare: async () => ({
                release() {
                  released = true;
                },
              }),
            },
          ),
          binding(
            2,
            provider(async function* (request) {
              yield event(request, 0, {
                type: "TextDelta",
                text: "Fast sibling",
              });
              yield event(request, 1, { type: "RunCompleted" });
            }),
          ),
        ],
      });
      const result = await handle.done;
      assert.deepEqual(
        result.contestants.map((item) => item.state),
        ["failed", "completed"],
      );
      assert.equal(result.contestants[0]!.error?.code, "timeout");
      assert.equal(result.contestants[1]!.text, "Fast sibling");
      assert.equal(released, false);
      gate.resolve();
      await handle.resourcesDrained;
      assert.equal(released, true);
    } finally {
      gate.resolve();
      await engine.close();
      db.close();
    }
  },
);

test("canceling during model preparation keeps late-acquired resources leased until preparation finishes", async () => {
  const { db, store } = await ready();
  const entered = deferred();
  const gate = deferred();
  let released = false;
  let started = false;
  const engine = new ArenaEngine(store, { createId: idSource() });
  try {
    const handle = await engine.start({
      prompt: "Prepare",
      contestants: [
        binding(
          1,
          provider(async function* (request) {
            started = true;
            yield event(request, 0, { type: "RunCompleted" });
          }),
          {
            prepare: async () => {
              entered.resolve();
              await gate.promise;
              return {
                release() {
                  released = true;
                },
              };
            },
          },
        ),
      ],
    });
    await entered.promise;
    await handle.cancel();
    assert.equal((await handle.done).contestants[0]!.state, "canceled");
    assert.equal(started, false);
    assert.equal(released, false);
    gate.resolve();
    await handle.resourcesDrained;
    assert.equal(released, true);
  } finally {
    gate.resolve();
    await engine.close();
    db.close();
  }
});
