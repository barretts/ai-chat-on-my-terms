import { afterEach, expect, test } from "vitest";
import { complete, startServer } from "./fake-model-server.mjs";

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

test("complete() covers the three request shapes the app makes", () => {
  const state = { counter: 0 };
  const chat = complete(
    { messages: [{ role: "user", content: "hello there" }] },
    state,
  );
  expect(chat.json).toBe(false);
  expect(chat.text).toContain("hello there");

  const seat = complete(
    {
      messages: [
        { role: "system", content: 'Your name in this room is "Sal the Chef"' },
        { role: "user", content: "anyone cooking?" },
      ],
    },
    state,
  );
  expect(seat.text).toBe("Sal the Chef: Fake beat 2 for Sal the Chef.");

  const selector = complete(
    {
      messages: [
        {
          role: "user",
          content:
            "pick a speaker\n- seat id aa: Ann\n- seat id bb: Bob\n- seat id cc: Cy",
        },
      ],
    },
    state,
  );
  expect(selector.json).toBe(true);
  expect(JSON.parse(selector.text)).toEqual({
    scores: [
      { seat: "cc", score: 3 },
      { seat: "bb", score: 2 },
      { seat: "aa", score: 1 },
    ],
  });
});

test("served endpoints stream SSE, reply non-stream, and list models", async () => {
  const server = await startServer(0);
  close = server.close;
  const base = `http://127.0.0.1:${server.port}/v1`;

  const models = await fetch(`${base}/models`).then((r) => r.json());
  expect(models.data).toEqual([{ id: "fake-fast", object: "model" }]);

  const streamed = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "count words" }],
    }),
  }).then((r) => r.text());
  const deltas = streamed
    .split("\n\n")
    .filter((event) => event.startsWith("data:") && !event.includes("[DONE]"))
    .map((event) => JSON.parse(event.slice(5)).choices[0].delta.content ?? "");
  const words = deltas.join("");
  expect(words).toMatch(/^Fake reply \d+ to: count words$/);
  expect(deltas.length).toBeGreaterThan(3);

  const plain = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "again" }],
    }),
  }).then((r) => r.json());
  expect(plain.choices[0].message.content).toContain("again");
  expect(server.state.counter).toBeGreaterThanOrEqual(2);
});
