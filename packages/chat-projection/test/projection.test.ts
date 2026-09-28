import { describe, expect, it } from "vitest";
import type { RunEvent } from "@locallab/contracts/run-events";
import {
  ProjectionTerminalError,
  RunEventProjection,
  createChatTransport,
  toUIMessage,
} from "../src/index.js";

const runA = "018f0000-0000-7000-8000-000000000001";
const runB = "018f0000-0000-7000-8000-000000000002";
const speakerA = "018f0000-0000-7000-8000-000000000011";
const speakerB = "018f0000-0000-7000-8000-000000000012";
const now = "2026-09-26T12:00:00Z";
function event<T extends RunEvent["type"]>(
  type: T,
  runId: string,
  sequence: number,
  extra: object = {},
): RunEvent {
  return { type, runId, sequence, timestamp: now, ...extra } as RunEvent;
}

describe("run event projection", () => {
  it("keeps interleaved group streams and identities separate", () => {
    const projection = new RunEventProjection();
    projection.apply(event("RunStarted", runA, 0, { participantId: speakerA }));
    projection.apply(event("RunStarted", runB, 0, { participantId: speakerB }));
    projection.apply(
      event("TextDelta", runB, 1, { participantId: speakerB, text: "second" }),
    );
    projection.apply(
      event("TextDelta", runA, 1, { participantId: speakerA, text: "first" }),
    );

    expect(projection.getMessage(runA)).toMatchObject({
      runId: runA,
      participantId: speakerA,
      parts: [{ type: "text", text: "first" }],
    });
    expect(projection.getMessage(runB)).toMatchObject({
      runId: runB,
      participantId: speakerB,
      parts: [{ type: "text", text: "second" }],
    });
  });

  it("deduplicates replayed fragments while preserving adjacent fragments", () => {
    const projection = new RunEventProjection();
    const first = event("TextDelta", runA, 0, { text: "hel" });
    expect(projection.apply(first)).toBe("applied");
    expect(projection.apply(first)).toBe("duplicate");
    projection.apply(event("TextDelta", runA, 1, { text: "lo" }));
    expect(projection.getMessage(runA)?.parts).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("retains reasoning, tools, sources and usage in transcript and UIMessage view", () => {
    const projection = new RunEventProjection();
    projection.apply(event("ReasoningDelta", runA, 0, { text: "thinking" }));
    projection.apply(
      event("ToolCall", runA, 1, {
        invocationId: speakerA,
        name: "lookup",
        input: { q: 1 },
      }),
    );
    projection.apply(
      event("ToolResult", runA, 2, { invocationId: speakerA, output: "ok" }),
    );
    projection.apply(
      event("Source", runA, 3, {
        url: "https://example.test",
        title: "Example",
      }),
    );
    projection.apply(
      event("Usage", runA, 4, { inputTokens: 12, outputTokens: 5 }),
    );
    const message = projection.getMessage(runA)!;
    expect(message.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "tool-call",
      "tool-result",
      "source",
    ]);
    expect(message.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(toUIMessage(message).parts).toContainEqual({
      type: "reasoning",
      text: "thinking",
    });
    expect(toUIMessage(message).parts).toContainEqual({
      type: "tool-lookup",
      toolCallId: speakerA,
      state: "input-available",
      input: { q: 1 },
    });
  });

  it("restores replay cursors and rejects fresh events after a terminal event", () => {
    const original = new RunEventProjection();
    original.apply(event("TextDelta", runA, 3, { text: "persist me" }));
    original.apply(event("RunCompleted", runA, 4, { finishReason: "stop" }));
    const restored = new RunEventProjection(original.snapshot());
    expect(
      restored.apply(event("TextDelta", runA, 3, { text: "persist me" })),
    ).toBe("duplicate");
    expect(() =>
      restored.apply(event("TextDelta", runA, 5, { text: "late" })),
    ).toThrow(ProjectionTerminalError);
    expect(restored.getMessage(runA)).toMatchObject({
      status: "completed",
      finishReason: "stop",
      parts: [{ type: "text", text: "persist me" }],
    });
  });

  it("projects cancel and failure terminal states", () => {
    const projection = new RunEventProjection();
    projection.apply(event("RunCanceled", runA, 0, { reason: "user stop" }));
    projection.apply(
      event("RunFailed", runB, 0, {
        error: { code: "offline", message: "gone", recoverable: true },
      }),
    );
    expect(projection.getMessage(runA)).toMatchObject({
      status: "canceled",
      error: { code: "canceled" },
    });
    expect(projection.getMessage(runB)).toMatchObject({
      status: "failed",
      error: { code: "offline", recoverable: true },
    });
  });

  it("marks active runs canceled when a transport is stopped", () => {
    const projection = new RunEventProjection();
    projection.apply(event("TextDelta", runA, 0, { text: "partial" }));
    expect(projection.cancelActive("Stopped by user")).toMatchObject([
      { runId: runA, status: "canceled", error: { code: "canceled" } },
    ]);
    expect(() =>
      projection.apply(event("TextDelta", runA, 2, { text: "late" })),
    ).toThrow(ProjectionTerminalError);
  });

  it("reconnects from snapshot and closes the stream", async () => {
    const projection = new RunEventProjection();
    projection.apply(event("TextDelta", runA, 0, { text: "saved" }));
    const reader = createChatTransport()
      .reconnectToStream({ snapshot: projection.snapshot() })
      .getReader();
    const result = await reader.read();
    expect(result.value?.parts).toEqual([{ type: "text", text: "saved" }]);
    expect((await reader.read()).done).toBe(true);
  });
});
