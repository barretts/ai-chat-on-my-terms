import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createHttpTransport } from "@locallab/network-http";
import { createOllamaChatProvider } from "@locallab/provider-ollama-chat";
import { ArenaEngine } from "../src/index.js";
import { binding, deferred, id, idSource, ready } from "./helpers.js";

test(
  "real HTTP Ollama streams race four exact models and persist every answer/failure",
  { timeout: 15_000 },
  async () => {
    const { db, store } = await ready();
    const responses: ServerResponse[] = [];
    const bodies: Array<{
      model: string;
      messages: unknown[];
      options: unknown;
    }> = [];
    const allPosted = deferred();
    const gate = deferred();
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.url, "/api/chat");
        const pieces: Buffer[] = [];
        for await (const piece of request) pieces.push(Buffer.from(piece));
        const body = JSON.parse(Buffer.concat(pieces).toString("utf8")) as {
          model: string;
          messages: unknown[];
          options: unknown;
        };
        bodies.push(body);
        responses.push(response);
        if (bodies.length === 4) allPosted.resolve();
        await gate.promise;
        if (body.model === "fixture-3") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end('{"error":"Bearer private-error-must-not-persist"}');
          return;
        }
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        const first =
          JSON.stringify({
            message: {
              role: "assistant",
              content: `Answer from ${body.model}: `,
            },
          }) + "\n";
        // Exercise the actual adapter's decoder across fragmented network writes.
        response.write(first.slice(0, 13));
        await new Promise((resolve) => setTimeout(resolve, 5));
        response.write(first.slice(13));
        await new Promise((resolve) => setTimeout(resolve, 5));
        response.write(
          JSON.stringify({
            message: { role: "assistant", content: "streamed" },
          }) + "\n",
        );
        response.end(
          JSON.stringify({
            done: true,
            done_reason: "stop",
            eval_count: 7,
            prompt_eval_count: 12,
          }) + "\n",
        );
      } catch {
        if (!response.destroyed) {
          response.writeHead(500);
          response.end();
        }
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const transport = createHttpTransport({
      fetch,
      policy: { authorizedOrigins: [origin], cleartextLanOrigins: [origin] },
      defaultTimeoutMs: 5000,
    });
    const resolved: string[] = [];
    const ollama = createOllamaChatProvider({
      transport,
      resolveConnection: async (connectionId) => {
        resolved.push(connectionId);
        return { baseUrl: origin };
      },
    });
    const updates: string[] = [];
    const engine = new ArenaEngine(store, {
      createId: idSource(),
      maxRunMs: 5000,
      onUpdate(update) {
        if (update.contestant.text)
          updates.push(
            `${update.contestant.modelId}:${update.contestant.text}`,
          );
      },
    });
    try {
      const handle = await engine.start({
        prompt: "Write one answer",
        context: [{ kind: "system", value: "Be concise" }],
        parameters: { temperature: 0.25 },
        contestants: [1, 2, 3, 4].map((number) =>
          binding(number, ollama, { connection: { baseUrl: origin } }),
        ),
      });
      await allPosted.promise;
      gate.resolve();
      const result = await handle.done;
      await handle.resourcesDrained;
      assert.equal(result.run.state, "completed");
      assert.deepEqual(
        result.contestants.map((contestant) => contestant.state),
        ["completed", "completed", "failed", "completed"],
      );
      assert.deepEqual(
        result.contestants.map((contestant) => contestant.text),
        [
          "Answer from fixture-1: streamed",
          "Answer from fixture-2: streamed",
          "",
          "Answer from fixture-4: streamed",
        ],
      );
      assert.deepEqual(
        resolved.sort(),
        [id(101), id(102), id(103), id(104)].sort(),
      );
      assert.deepEqual(bodies.map((body) => body.model).sort(), [
        "fixture-1",
        "fixture-2",
        "fixture-3",
        "fixture-4",
      ]);
      for (const body of bodies) {
        assert.deepEqual(body.messages, [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Write one answer" },
        ]);
        assert.deepEqual(body.options, { temperature: 0.25 });
      }
      for (const contestant of result.contestants.filter(
        (item) => item.state === "completed",
      )) {
        assert.ok(
          contestant.timing.ttftMs !== null && contestant.timing.ttftMs >= 0,
        );
        assert.equal(contestant.timing.providerOutputTokens, 7);
        assert.equal(contestant.timing.providerInputTokens, 12);
        assert.equal(contestant.timing.providerReportedTokensPerSecond, null); // Adapter contract did not report a backend rate.
        assert.ok(contestant.timing.reportedTokenCountPerSecond !== null);
      }
      assert.equal(result.contestants[2]!.error?.code, "unauthorized");
      assert.equal(
        JSON.stringify(result).includes("private-error-must-not-persist"),
        false,
      );
      assert.ok(
        updates.some((update) =>
          update.includes("fixture-4:Answer from fixture-4: "),
        ),
      );
      assert.equal((await store.read(handle.id))!.contestants.length, 4);
    } finally {
      gate.resolve();
      for (const response of responses) response.destroy();
      await engine.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      db.close();
    }
  },
);
