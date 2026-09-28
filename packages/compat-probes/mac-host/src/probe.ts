import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "../../../../");
const companionManifest = join(root, "apps/companion/Cargo.toml");
const isMac = platform() === "darwin";

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (
        response.ok &&
        (await response.json()).service === "locallab-companion"
      )
        return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Companion health endpoint did not become ready: ${url}`);
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(root, ".tmp-mac-host-probe-"));
  const port = 43_180 + Math.floor(Math.random() * 1_000);
  const address = `127.0.0.1:${port}`;
  const dbPath = isMac
    ? join(
        homedir(),
        "Library/Application Support/LocalLab/compat-probe.sqlite",
      )
    : join(scratch, "compat-probe.sqlite");
  let child: ReturnType<typeof spawn> | undefined;

  try {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS probe (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT OR REPLACE INTO probe VALUES (?, ?)").run(
      "transport",
      "ok",
    );
    const row = db
      .prepare("SELECT value FROM probe WHERE key = ?")
      .get("transport") as { value: string } | undefined;
    db.close();
    if (row?.value !== "ok") throw new Error("SQLite create/read check failed");

    child = spawn(
      "cargo",
      ["run", "--locked", "--manifest-path", companionManifest],
      {
        cwd: root,
        env: { ...process.env, LOCALLAB_COMPANION_ADDR: address },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let childOutput = "";
    child.stdout?.on(
      "data",
      (chunk: Buffer) => (childOutput += chunk.toString()),
    );
    child.stderr?.on(
      "data",
      (chunk: Buffer) => (childOutput += chunk.toString()),
    );
    try {
      await waitForHealth(`http://${address}/health`);
    } catch (error) {
      throw new Error(
        `${String(error)}\nCompanion output:\n${childOutput.trim()}`,
      );
    }
    const transport = await fetch(`http://${address}/health`);
    if (!transport.ok)
      throw new Error(`Local HTTP client returned ${transport.status}`);
    child.kill("SIGTERM");
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) =>
          child?.once("exit", (code, signal) => resolveExit({ code, signal })),
      ),
      delay(5_000).then(() => "timeout" as const),
    ]);
    if (exit === "timeout")
      throw new Error("Companion did not exit after SIGTERM");

    console.log(
      JSON.stringify(
        {
          host: {
            platform: process.platform,
            arch: process.arch,
            macOS: isMac,
          },
          sqlite: { path: dbPath, createRead: "passed" },
          companion: {
            localHttp: "passed",
            exitObserved: true,
            exitCode: exit.code,
            exitSignal: exit.signal,
          },
          macBuild: isMac
            ? "run cargo and tauri release builds separately"
            : "pending: macOS host required",
          llamaCpp: "pending: T029 owns the pinned inference sidecar",
          childOutput: childOutput.trim().slice(-1_000),
        },
        null,
        2,
      ),
    );
    if (!isMac) process.exitCode = 2;
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
