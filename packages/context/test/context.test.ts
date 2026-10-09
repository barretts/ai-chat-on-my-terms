import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextBudgetError,
  packContext,
  type ContextMessage,
} from "../src/index.js";

const message = (id: string, text: string): ContextMessage => ({
  id,
  role: id.startsWith("u") ? "user" : "assistant",
  parts: [{ type: "text", text }],
});

const charsAsTokens = (messages: readonly ContextMessage[]) =>
  messages.reduce(
    (sum, item) =>
      sum + item.parts.reduce((n, part) => n + (part.text?.length ?? 1), 0),
    0,
  );

const trimmingPolicies = ["roll", "cut-middle", "summarize"] as const;

test("stop reports context full and output reserve reduces input capacity", async () => {
  await assert.rejects(
    packContext({
      messages: [message("u1", "abcdefgh")],
      tokenBudget: 10,
      reservedOutputTokens: 3,
      policy: "stop",
      countTokens: charsAsTokens,
    }),
    ContextBudgetError,
  );
});

test("roll retains newest complete messages without splitting tool call/result", async () => {
  const messages: ContextMessage[] = [
    message("u1", "oldest"),
    {
      id: "a2",
      role: "assistant",
      parts: [{ type: "tool-call", invocationId: "call-1", name: "lookup" }],
    },
    {
      id: "t3",
      role: "tool",
      parts: [{ type: "tool-result", invocationId: "call-1", output: "ok" }],
    },
    message("u4", "recent"),
  ];
  const packed = await packContext({
    messages,
    tokenBudget: 15,
    reservedOutputTokens: 5,
    policy: "roll",
    countTokens: charsAsTokens,
  });
  const ids = packed.messages.map((item) => item.id);
  assert.deepEqual(ids, ["a2", "t3", "u4"]);
  assert.deepEqual(packed.omittedMessageIds, ["u1"]);
});

test("cut-middle retains the opening and latest context when they fit", async () => {
  const messages = [
    message("u1", "opening"),
    message("a2", "middle one"),
    message("u3", "middle two"),
    message("a4", "latest"),
  ];
  const packed = await packContext({
    messages,
    tokenBudget: 22,
    reservedOutputTokens: 5,
    policy: "cut-middle",
    countTokens: charsAsTokens,
  });
  assert.equal(packed.messages[0]?.id, "u1");
  assert.equal(packed.messages.at(-1)?.id, "a4");
  assert.ok(packed.omittedMessageIds.includes("a2"));
  assert.ok(packed.omittedMessageIds.includes("u3"));
});

test("roll never drops system or developer instructions", async () => {
  const system: ContextMessage = {
    id: "system",
    role: "system",
    parts: [{ type: "text", text: "Use only the configured tools." }],
  };
  const messages = [
    system,
    message("u-old", "older context"),
    message("u-new", "latest"),
  ];
  const packed = await packContext({
    messages,
    tokenBudget: 45,
    reservedOutputTokens: 5,
    policy: "roll",
    countTokens: charsAsTokens,
  });
  assert.equal(packed.messages[0]?.id, "system");
  assert.ok(packed.messages.some((item) => item.id === "u-new"));
});

test("summary compaction preserves source IDs and cancellation leaves input unchanged", async () => {
  const source = [
    message("u1", "old history"),
    message("a2", "older reply"),
    message("u3", "current"),
  ];
  const before = structuredClone(source);
  const packed = await packContext({
    messages: source,
    tokenBudget: 23,
    reservedOutputTokens: 5,
    policy: "summarize",
    countTokens: charsAsTokens,
    summarize: async () => "old info",
  });
  assert.ok(packed.messages.some((item) => item.compacted));
  assert.deepEqual(source, before);
  assert.equal(packed.compactedMessageIds.length, 2);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    packContext({
      messages: source,
      tokenBudget: 20,
      reservedOutputTokens: 5,
      policy: "summarize",
      countTokens: charsAsTokens,
      signal: controller.signal,
      summarize: async () => "summary",
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(source, before);
});

test("every policy rejects instructions that exceed the reserved input budget", async () => {
  for (const policy of ["stop", ...trimmingPolicies] as const) {
    for (const role of ["system", "developer"] as const) {
      let summarized = false;
      const instruction: ContextMessage = {
        id: "instruction",
        role,
        parts: [{ type: "text", text: "123456" }],
      };
      await assert.rejects(
        packContext({
          messages: [instruction, message("u-current", "x")],
          tokenBudget: 9,
          reservedOutputTokens: 4,
          policy,
          countTokens: charsAsTokens,
          summarize: async () => {
            summarized = true;
            return "s";
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ContextBudgetError, `${policy}/${role}`);
          assert.equal(error.code, "context-full");
          assert.match(error.message, /6 input tokens.*input budget is 5/);
          return true;
        },
      );
      assert.equal(summarized, false);
    }
  }
});

test("trimming retains the required current user message or rejects its budget", async () => {
  const current = message("u-current", "ask");
  const messages = [
    message("u-old", "old history"),
    current,
    message("a-after", "ok"),
  ];
  for (const policy of trimmingPolicies) {
    const options = {
      messages,
      requiredMessageIds: [current.id],
      reservedOutputTokens: 2,
      policy,
      countTokens: charsAsTokens,
      summarize: async () => "s",
    };
    const packed = await packContext({ ...options, tokenBudget: 6 });
    assert.deepEqual(
      packed.messages.find((item) => item.id === current.id),
      current,
    );
    assert.ok(!packed.omittedMessageIds.includes(current.id));
    assert.ok(!packed.compactedMessageIds.includes(current.id));
    assert.ok(packed.estimatedInputTokens <= 4);
    await assert.rejects(
      packContext({ ...options, tokenBudget: 4 }),
      ContextBudgetError,
    );
  }
});

test("requiring a tool result retains its whole atomic group or rejects the budget", async () => {
  const call: ContextMessage = {
    id: "call",
    role: "assistant",
    parts: [{ type: "tool-call", invocationId: "lookup", text: "call" }],
  };
  const result: ContextMessage = {
    id: "result",
    role: "tool",
    parts: [{ type: "tool-result", invocationId: "lookup", text: "result" }],
  };
  const messages = [
    message("u-old", "old history"),
    call,
    result,
    message("u-new", "new"),
  ];
  for (const policy of trimmingPolicies) {
    const options = {
      messages,
      requiredMessageIds: [result.id],
      reservedOutputTokens: 2,
      policy,
      countTokens: charsAsTokens,
      summarize: async () => "s",
    };
    const packed = await packContext({ ...options, tokenBudget: 13 });
    const callIndex = packed.messages.findIndex((item) => item.id === call.id);
    assert.ok(callIndex >= 0);
    assert.deepEqual(packed.messages.slice(callIndex, callIndex + 2), [
      call,
      result,
    ]);
    assert.ok(!packed.compactedMessageIds.includes(call.id));
    assert.ok(!packed.compactedMessageIds.includes(result.id));
    assert.ok(packed.estimatedInputTokens <= 11);
    // The result alone fits; the required call/result group needs ten tokens.
    await assert.rejects(
      packContext({ ...options, tokenBudget: 11 }),
      ContextBudgetError,
    );
  }
});

test("summary retries never send the required current message to the summarizer", async () => {
  const current = message("u-current", "ask");
  const messages = [
    message("u-old", "old history"),
    current,
    message("a-after", "ok"),
  ];
  const before = structuredClone(messages);
  const summaryInputs: string[][] = [];
  await assert.rejects(
    packContext({
      messages,
      requiredMessageIds: [current.id],
      tokenBudget: 6,
      reservedOutputTokens: 2,
      policy: "summarize",
      countTokens: charsAsTokens,
      summarize: async (source) => {
        summaryInputs.push(source.map((item) => item.id));
        return "summary cannot fit";
      },
    }),
    ContextBudgetError,
  );
  assert.ok(summaryInputs.length > 1);
  assert.ok(summaryInputs.every((ids) => !ids.includes(current.id)));
  assert.deepEqual(messages, before);
});
