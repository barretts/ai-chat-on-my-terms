// Launch/kill/clean helpers for the built Tauri Windows desktop app, plus a
// loopback OpenAI-compatible fixture server. Used by desktop-chat.spec.ts;
// nothing here contacts a real vendor backend.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

export const CDP_PORT = Number(process.env.LOCALLAB_DESKTOP_CDP_PORT ?? 9222);
export const FIXTURE_PORT = Number(
  process.env.LOCALLAB_DESKTOP_FIXTURE_PORT ?? 4599,
);

// Where the fixture dumps the request bodies it sees; the smoke config's
// output dir default is tmp/desktop-smoke-results.
export const REQUEST_LOG_DIR =
  process.env.LOCALLAB_DESKTOP_SMOKE_RESULTS ??
  path.resolve(__dirname, "../../../tmp/desktop-smoke-results");
fs.mkdirSync(REQUEST_LOG_DIR, { recursive: true });
fs.rmSync(path.join(REQUEST_LOG_DIR, "fixture-requests.log"), { force: true });
export const EXE_BASENAME = "locallab-desktop";
const RELEASE_DIR = path.resolve(
  __dirname,
  "../../../apps/desktop/src-tauri/target/release",
);

// Locate the built release exe. LOCALLAB_DESKTOP_EXE overrides the scan;
// otherwise exactly one *.exe in target/release named like the Tauri
// bundle (locallab-desktop.exe, verified on this host) may match.
export function findExe() {
  if (process.env.LOCALLAB_DESKTOP_EXE) return process.env.LOCALLAB_DESKTOP_EXE;
  const matches = fs
    .readdirSync(RELEASE_DIR)
    .filter((name) => name.toLowerCase().includes(EXE_BASENAME))
    .filter((name) => name.toLowerCase().endsWith(".exe"));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one "${EXE_BASENAME}" exe in ${RELEASE_DIR}, found: ${matches.join(", ") || "none"}`,
    );
  }
  return path.join(RELEASE_DIR, matches[0]);
}

// Delete the app's Windows app-data directories so onboarding restarts. Only
// the two known per-app folders are ever removed; the guard throws if the
// identifier is missing from the resolved path.
export function resetAppData() {
  const roots = [];
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, "app.locallab.desktop"));
  }
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, "app.locallab.desktop"));
  }
  for (const dir of roots) {
    if (!dir.includes("app.locallab.desktop")) {
      throw new Error(`refusing to delete unexpected path: ${dir}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return roots;
}

// The roaming SQLite file the Rust shell opens at startup. If the app ever
// fell back to browser OPFS storage instead of the Tauri bridge, this file
// would exist (Rust creates it at launch) but hold no app rows.
export const NATIVE_DB_PATH = process.env.APPDATA
  ? path.join(process.env.APPDATA, "app.locallab.desktop", "locallab.sqlite")
  : "";

// Count persisted assistant transcript rows in the bridge-owned database.
// Returns -1 when the file is absent; readers never block on the app's WAL
// write lock.
export function countNativeAssistantRows(like) {
  if (!NATIVE_DB_PATH || !fs.existsSync(NATIVE_DB_PATH)) return -1;
  const db = new DatabaseSync(NATIVE_DB_PATH, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND parts_json LIKE ?",
      )
      .get(`%${like}%`);
    return Number(row.n);
  } finally {
    db.close();
  }
}

// Spawn the built app with a WebView2 remote-debugging port so Playwright can
// attach over CDP.
export function launchApp() {
  const exe = findExe();
  return spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: "ignore",
  });
}

export async function killApp(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise((done) => child.once("exit", done));
  }
  await sleep(1000); // Let WebView2 release its user-data dir locks.
}

// Poll the CDP endpoint until the debug port answers, up to `timeoutMs`.
export async function waitForCdp(port = CDP_PORT, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no error yet";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await sleep(500);
  }
  throw new Error(`CDP endpoint on port ${port} never came up: ${lastError}`);
}

// --- loopback OpenAI-compatible fixture (never a live vendor) ---

// Reply text switches on prompt content so the second call after an app
// restart gets a distinct answer without server-side call state.
function replyTextFor(promptText) {
  return promptText.includes("second after restart")
    ? "Second desktop fixture reply."
    : "Desktop fixture reply.";
}

function sseChunk(content) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-desktop-smoke",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "desktop-smoke",
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { role: "assistant", content },
        finish_reason: content === null ? "stop" : null,
      },
    ],
  })}\n\n`;
}

export function startFixtureServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Expose-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Type");
    const url = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ object: "list", data: [{ id: "desktop-smoke" }] }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!req.headers.authorization) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "missing Authorization" } }),
        );
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        fs.appendFileSync(
          path.join(REQUEST_LOG_DIR, "fixture-requests.log"),
          `${req.method} ${req.url} :: ${body.slice(0, 4000)}\n`,
        );
        let promptText = body;
        try {
          promptText = JSON.stringify(JSON.parse(body));
        } catch {
          // Keep the raw body if it isn't valid JSON.
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "close",
        });
        res.write(sseChunk(replyTextFor(promptText)));
        res.write(sseChunk(null));
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  server.listen(FIXTURE_PORT, "127.0.0.1");
  return server;
}

export async function stopFixtureServer(server) {
  await new Promise((done) => server.close(done));
}
