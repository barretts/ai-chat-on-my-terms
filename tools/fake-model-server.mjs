#!/usr/bin/env node
// Deterministic OpenAI-compatible endpoint for hermetic local iteration
// (docs/hermetic-ui-lane.md). Speaks the three shapes this app uses:
// streamed chat completions, non-streamed completions, and the group-chat
// topic-interest JSON call. It deliberately behaves like a parroting model:
// when the group driver's transcript note names the seat, the reply carries
// the `Name:` prefix a sloppy local model adds, so the app-side
// stripSpeakerPrefix fix (composition/chat/group-driver.ts) is exercised.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MODEL = "fake-fast";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function allText(payload) {
  return (payload.messages ?? [])
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.parts ?? []).map((part) => part.text ?? "").join(" "),
    )
    .join("\n");
}

function lastUserText(payload) {
  const users = (payload.messages ?? []).filter(
    (message) => message.role === "user",
  );
  const last = users.at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : (last.parts ?? []).map((part) => part.text ?? "").join(" ");
}

/** Reply text + JSON mode detection for one chat completion request. */
export function complete(payload, state) {
  const transcript = allText(payload);
  const seatIds = [...transcript.matchAll(/^- seat id (\S+):/gm)].map(
    (match) => match[1],
  );
  if (seatIds.length > 0) {
    // Topic-interest selector: reverse seating order so the room visibly
    // re-orders speakers when the JSON path is live.
    state.counter += 1;
    return {
      json: true,
      text: JSON.stringify({
        scores: seatIds
          .map((seat, index) => ({ seat, score: index + 1 }))
          .reverse(),
      }),
    };
  }
  const seat = transcript.match(/Your name in this room is "([^"]+)"/);
  state.counter += 1;
  if (seat) {
    // Parroting model behavior; the app must strip this prefix.
    return {
      json: false,
      text: `${seat[1]}: Fake beat ${state.counter} for ${seat[1]}.`,
    };
  }
  const prompt = lastUserText(payload).replace(/\s+/g, " ").trim();
  const short = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  return { json: false, text: `Fake reply ${state.counter} to: ${short}` };
}

function sseChunks(text, writeHead) {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
  ];
  for (const word of text.match(/\S+\s*|\s+/g) ?? []) {
    chunks.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: word }, finish_reason: null }] })}\n\n`,
    );
  }
  chunks.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  );
  writeHead("text/event-stream", chunks.join(""));
}

export function startServer(
  port = Number(process.env.FAKE_MODEL_PORT ?? 8899),
) {
  const state = { counter: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x"}`);
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: MODEL, object: "model" }],
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const payload = JSON.parse(await readBody(req));
      const result = complete(payload, state);
      if (payload.stream) {
        sseChunks(result.text, (type, body) => {
          res.writeHead(200, { ...headers, "content-type": type });
          res.end(body);
        });
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: result.text },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404, { ...headers, "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `fake-model: no route ${req.method} ${url.pathname}`,
        },
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () =>
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer().then((server) => {
    console.log(
      `fake model server on http://127.0.0.1:${server.port}/v1 (model ${MODEL})`,
    );
  });
}
