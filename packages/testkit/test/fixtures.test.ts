import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RunEventBatchSchema } from "@locallab/contracts/run-events";
import type { RunEvent } from "@locallab/contracts/run-events";
import {
  decodeUtf8Fragments,
  parseNdjson,
  parseSseData,
  splitUtf8,
  startFragmentedServer,
} from "../src/fragmented-server.js";
import { createFakeNativePorts } from "../src/fake-native-ports.js";
import { recordedRedactedContent } from "../src/recorded-content.js";

const runId = "018f1f1e-7b4a-7c12-8a10-000000000001";
const fakeRunRequest = () => ({
  runId,
  conversationId: runId,
  messageId: runId,
  providerConnectionId: runId,
  modelId: "fixture-model",
  context: [],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
});
const events = JSON.parse(
  await readFile(
    new URL("../fixtures/streaming-events.json", import.meta.url),
    "utf8",
  ),
) as RunEvent[];

describe("stream fixture utilities", () => {
  it("decodes fragmented UTF-8 and parses SSE records", () => {
    const wire = events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const encoded = Buffer.from(wire);
    const catByteOffset = encoded.indexOf(Buffer.from("🐈")) + 2;
    const fragments = splitUtf8(wire, [1, catByteOffset, encoded.length - 1]);
    const decoded = decodeUtf8Fragments(fragments);

    expect(decoded).toBe(wire);
    expect(parseSseData<unknown>(decoded)).toEqual(events);
    expect(RunEventBatchSchema.safeParse(parseSseData(decoded)).success).toBe(
      true,
    );
  });

  it("decodes fragmented UTF-8 and parses NDJSON records", () => {
    const wire = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const fragments = splitUtf8(wire, [
      2,
      Buffer.from(wire).indexOf(Buffer.from("🐈")) + 1,
    ]);
    const decoded = decodeUtf8Fragments(fragments);

    expect(parseNdjson<unknown>(decoded)).toEqual(events);
    expect(RunEventBatchSchema.safeParse(parseNdjson(decoded)).success).toBe(
      true,
    );
  });

  it("serves exact byte fragments and observes client cancellation", async () => {
    const fragments = splitUtf8("data: 🐈\n\n", [9]);
    const server = await startFragmentedServer({
      contentType: "text/event-stream",
      fragments,
      delayMs: 20,
    });
    const abort = new AbortController();
    try {
      const response = await fetch(server.url, { signal: abort.signal });
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();
      abort.abort();
      await expect(server.disconnected).resolves.toBeUndefined();
    } finally {
      abort.abort();
      await server.close();
    }
  });

  it("serves fragmented NDJSON on the matching content type", async () => {
    const wire = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const server = await startFragmentedServer({
      contentType: "application/x-ndjson",
      fragments: splitUtf8(wire, [
        3,
        Buffer.from(wire).indexOf(Buffer.from("🐈")) + 2,
      ]),
    });
    try {
      const response = await fetch(server.url);
      expect(response.headers.get("content-type")).toContain(
        "application/x-ndjson",
      );
      const decoded = await response.text();
      expect(parseNdjson(decoded)).toEqual(events);
    } finally {
      await server.close();
    }
  });

  it("keeps recorded content synthetic and redacted", async () => {
    const fixtureText = await readFile(
      new URL("../fixtures/recorded-content.json", import.meta.url),
      "utf8",
    );
    const fixture = JSON.parse(fixtureText) as typeof recordedRedactedContent;
    expect(fixture.request.authorization).toBe("[REDACTED]");
    expect(fixture.request.prompt).toBe("[REDACTED]");
    expect(fixture.response.text).toBe("[REDACTED]");
    expect(fixtureText).not.toMatch(/\bBearer\s+\S+|sk-[A-Za-z0-9_-]{12,}/i);
  });
});

describe("fake native ports", () => {
  it("records calls deterministically and makes cancellation terminal", async () => {
    const ports = createFakeNativePorts(events.slice(0, 2));
    const controller = new AbortController();
    const stream = ports.provider.startRun(fakeRunRequest(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();

    const started = (await iterator.next()).value;
    expect(started?.type).toBe("RunStarted");
    controller.abort();
    const canceled = (await iterator.next()).value;
    expect(canceled?.type).toBe("RunCanceled");
    expect((await iterator.next()).done).toBe(true);
    expect(RunEventBatchSchema.safeParse([started, canceled]).success).toBe(
      true,
    );

    await ports.modelManager.load("fixture-model");
    await ports.modelManager.cancel("job-fixture");
    expect(ports.calls.loadedModels).toEqual(["fixture-model"]);
    expect(ports.calls.canceledJobs).toEqual(["job-fixture"]);
  });

  it("does not append cancellation after an existing terminal event", async () => {
    const ports = createFakeNativePorts(events);
    const controller = new AbortController();
    const iterator = ports.provider
      .startRun(fakeRunRequest(), controller.signal)
      [Symbol.asyncIterator]();
    const received = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
      received.push(event);
      if (event.type === "RunCompleted") controller.abort();
    }

    expect(received.map((event) => event.type)).toEqual([
      "RunStarted",
      "TextDelta",
      "RunCompleted",
    ]);
    expect(RunEventBatchSchema.safeParse(received).success).toBe(true);
  });
});
