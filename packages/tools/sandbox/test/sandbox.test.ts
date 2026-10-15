import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import {
  DockerSandboxRunner,
  validateSandboxJob,
  type SandboxJob,
} from "../src/index.js";

const job = (over: Partial<SandboxJob> = {}): SandboxJob => ({
  language: "python",
  code: "print(1)",
  limits: { timeoutMs: 10_000, maxOutputBytes: 4096 },
  ...over,
});

test("job validation rejects unsafe or unbounded requests", () => {
  assert.throws(
    () => validateSandboxJob(job({ language: "ruby" as never })),
    /Unsupported/,
  );
  assert.throws(() => validateSandboxJob(job({ code: "   " })), /empty/);
  assert.throws(
    () =>
      validateSandboxJob(
        job({ limits: { timeoutMs: 5, maxOutputBytes: 10 } }),
      ),
    /timeout/,
  );
  assert.throws(
    () =>
      validateSandboxJob(
        job({
          limits: { timeoutMs: 1000, maxOutputBytes: 10, memoryMb: 4096 },
        }),
      ),
    /memory limit is capped/,
  );
  assert.throws(
    () => validateSandboxJob(job({ artifactNames: ["../../escape"] })),
    /Artifact name/,
  );
  validateSandboxJob(job({ artifactNames: ["plot.png"] }));
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  constructor(private readonly onKill: () => void) {
    super();
  }
  kill() {
    this.killed = true;
    this.onKill();
  }
}

class FakeRunner extends DockerSandboxRunner {
  lastArgv: string[] = [];
  protected override spawnProcess(
    argv: string[],
  ): ChildProcessWithoutNullStreams {
    this.lastArgv = argv;
    const fake = new FakeChild(() =>
      setImmediate(() => fake.emit("close", null, "SIGKILL")),
    );
    return fake as unknown as ChildProcessWithoutNullStreams;
  }
}

test("container isolation flags are present verbatim", () => {
  const runner = new FakeRunner("locallab/sandbox-worker:0.1.0");
  void runner.run(job());
  const flags = runner.lastArgv;
  for (const flag of [
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--memory",
    "--cpus",
    "--pids-limit",
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
  ])
    assert.ok(flags.includes(flag), `missing flag ${flag}`);
  assert.ok(!flags.some((a) => a.includes("bind") || a.startsWith("-v")), "no host mounts");
});

test("cancellation kills the container and reports canceled", async () => {
  const runner = new FakeRunner("img");
  const controller = new AbortController();
  const run = runner.run(job(), controller.signal);
  const { promise: turnt, resolve: turn } = Promise.withResolvers();
  setImmediate(turn);
  await turnt;
  controller.abort();
  const result = await run;
  assert.equal(result.status, "canceled");
});

test("worker JSON statuses pass through; bad JSON maps by exit code", async () => {
  class JsonRunner extends DockerSandboxRunner {
    constructor(private readonly payload: string) {
      super("img");
    }
    protected override spawnProcess(
      _argv: string[],
    ): ChildProcessWithoutNullStreams {
      const fake = new FakeChild(() => {});
      setImmediate(() => {
        fake.stdout.write(this.payload);
        fake.emit("close", 0);
      });
      return fake as unknown as ChildProcessWithoutNullStreams;
    }
  }
  const ok = await new JsonRunner(
    JSON.stringify({ status: "ok", stdout: "1\n", stderr: "" }),
  ).run(job());
  assert.equal(ok.status, "ok");
  assert.equal(ok.stdout, "1\n");

  const oom = await new JsonRunner("killed").run(job());
  assert.equal(oom.status, "unavailable"); // exit 0, no JSON
});
