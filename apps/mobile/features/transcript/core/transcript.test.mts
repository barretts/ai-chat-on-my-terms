import { describe, expect, it } from "vitest";
import {
  assistantPlainText,
  assistantStatusLabel,
  mergeTranscriptRows,
} from "./index";

describe("native transcript rows", () => {
  it("distinguishes an exhausted output budget from a finished answer", () => {
    const message = {
      id: "run-limit",
      runId: "run-limit",
      role: "assistant" as const,
      status: "completed" as const,
      parts: [],
    };
    expect(
      assistantStatusLabel({ ...message, finishReason: "length" }),
    ).toContain("Output limit reached");
    expect(
      assistantStatusLabel({ ...message, finishReason: "max_tokens" }),
    ).toContain("Output limit reached");
    expect(assistantStatusLabel({ ...message, finishReason: "stop" })).toBe(
      "Response complete",
    );
    expect(
      assistantStatusLabel({
        ...message,
        status: "canceled",
        finishReason: "length",
      }),
    ).toBe("Response stopped");
  });
  it("keeps conversation order and stable IDs as assistant text streams", () => {
    const users = [
      { id: "user-2", role: "user" as const, text: "Hi", order: 1 },
    ];
    const first = {
      id: "run-9",
      runId: "run-9",
      role: "assistant" as const,
      order: 2,
      status: "running" as const,
      parts: [{ type: "text" as const, text: "Hel" }],
    };
    const later = {
      ...first,
      parts: [{ type: "text" as const, text: "Hello" }],
    };

    expect(mergeTranscriptRows(users, [first]).map(({ id }) => id)).toEqual([
      "user-2",
      "run-9",
    ]);
    expect(mergeTranscriptRows(users, [later])[1]?.id).toBe("run-9");
    expect(assistantPlainText(later)).toBe("Hello");
  });

  it("retains reasoning and tool parts while exposing only plain assistant text", () => {
    const message = {
      id: "run-1",
      runId: "run-1",
      role: "assistant" as const,
      order: 0,
      status: "completed" as const,
      parts: [
        { type: "reasoning" as const, text: "checking" },
        {
          type: "tool-call" as const,
          invocationId: "t1",
          name: "search",
          input: {},
        },
        { type: "text" as const, text: "Done." },
      ],
    };
    expect(assistantPlainText(message)).toBe("Done.");
    expect(mergeTranscriptRows([], [message])[0]?.status).toBe("completed");
  });
});
