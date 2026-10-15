import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

export type SandboxLanguage = "python" | "javascript";

export interface SandboxJob {
  language: SandboxLanguage;
  code: string;
  args?: string[];
  stdin?: string;
  limits: SandboxLimits;
  /** Artifact filenames the program may write under /work/out (max 8). */
  artifactNames?: string[];
}

export interface SandboxLimits {
  /** Wall-clock limit for the whole run; enforced inside and outside. */
  timeoutMs: number;
  /** Max bytes kept for stdout and for stderr each. */
  maxOutputBytes: number;
  /** Container memory ceiling in MB; default 256, hard cap 1024. */
  memoryMb?: number;
  /** Fraction of one CPU; default 0.5, cap 2. */
  cpus?: number;
}

export type SandboxStatus =
  | "ok"
  | "timeout"
  | "canceled"
  | "runtime-error"
  | "quota"
  | "unavailable";

export interface SandboxArtifact {
  name: string;
  bytes: number;
  base64: string;
  truncated: boolean;
}

export interface SandboxResult {
  status: SandboxStatus;
  message?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
  artifacts: SandboxArtifact[];
}

/** Runner port: language jobs are explicit, cancelable, and bounded. */
export interface SandboxRunner {
  run(job: SandboxJob, signal?: AbortSignal): Promise<SandboxResult>;
}

const DEFAULT_MEMORY_MB = 256;
const MAX_MEMORY_MB = 1024;
const MAX_CPUS = 2;
const MAX_TIMEOUT_MS = 120_000;
const MAX_ARTIFACTS = 8;

export function validateSandboxJob(job: SandboxJob): void {
  if (job.language !== "python" && job.language !== "javascript")
    throw new Error(`Unsupported sandbox language "${job.language}".`);
  if (job.code.trim() === "")
    throw new Error("The sandbox program is empty.");
  if (job.limits.timeoutMs < 100 || job.limits.timeoutMs > MAX_TIMEOUT_MS)
    throw new Error(`Sandbox timeout must be 100–${MAX_TIMEOUT_MS} ms.`);
  if (job.limits.maxOutputBytes < 1)
    throw new Error("Sandbox output limit must be positive.");
  if ((job.limits.memoryMb ?? DEFAULT_MEMORY_MB) > MAX_MEMORY_MB)
    throw new Error(`Sandbox memory limit is capped at ${MAX_MEMORY_MB} MB.`);
  if ((job.limits.cpus ?? 0.5) > MAX_CPUS)
    throw new Error(`Sandbox CPU limit is capped at ${MAX_CPUS}.`);
  if ((job.artifactNames?.length ?? 0) > MAX_ARTIFACTS)
    throw new Error(`At most ${MAX_ARTIFACTS} artifacts per sandbox run.`);
  for (const name of job.artifactNames ?? [])
    if (!/^[\w.-]{1,64}$/.test(name))
      throw new Error(
        `Artifact name "${name}" must be 1–64 characters of A–Z a–z 0–9 . _ -.`,
      );
}

/**
 * Docker worker runner (TL-08): every run is a fresh container with no host
 * mounts, read-only rootfs, no network by default, bounded CPU/memory/PID
 * count, and an unprivileged user. Cancellation kills the container; quota
 * and timeout conditions are surfaced as explicit statuses, never silent.
 */
export class DockerSandboxRunner implements SandboxRunner {
  constructor(
    private readonly image: string,
    private readonly dockerPath = "docker",
  ) {}

  async run(job: SandboxJob, signal?: AbortSignal): Promise<SandboxResult> {
    validateSandboxJob(job);
    const started = Date.now();
    const memoryMb = job.limits.memoryMb ?? DEFAULT_MEMORY_MB;
    const cpus = job.limits.cpus ?? 0.5;
    const argv = [
      "run",
      "--rm",
      "--interactive",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/work:rw,size=64m,mode=1777",
      "--memory",
      `${memoryMb}m`,
      "--memory-swap",
      `${memoryMb}m`,
      "--cpus",
      String(cpus),
      "--pids-limit",
      "64",
      "--user",
      "65534:65534",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "-w",
      "/work",
      this.image,
      "/worker/run.sh",
    ];
    const request = JSON.stringify({
      language: job.language,
      code: job.code,
      ...(job.args ? { args: job.args } : {}),
      ...(job.stdin !== undefined ? { stdin: job.stdin } : {}),
      timeoutMs: job.limits.timeoutMs,
      maxOutputBytes: job.limits.maxOutputBytes,
      ...(job.artifactNames ? { artifactNames: job.artifactNames } : {}),
    });
    const { promise, resolve, reject } =
      Promise.withResolvers<SandboxResult>();
    const child = this.spawnProcess(argv);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutFull = "";
    let stderrText = "";
    let killedBy = "";
    const cancel = () => {
      killedBy = killedBy || "canceled";
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      killedBy = killedBy || "timeout";
      child.kill("SIGKILL");
    }, job.limits.timeoutMs + 5_000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes <= job.limits.maxOutputBytes)
        stdoutFull += chunk.toString("utf8");
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < job.limits.maxOutputBytes) {
        const room = job.limits.maxOutputBytes - stderrBytes;
        stderrText += chunk.subarray(0, room).toString("utf8");
      }
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Sandbox runner unavailable: ${error.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const durationMs = Date.now() - started;
      let parsed: {
        status?: SandboxStatus;
        message?: string;
        stdout?: string;
        stderr?: string;
        artifacts?: SandboxArtifact[];
      } | null = null;
      try {
        parsed = JSON.parse(stdoutFull);
      } catch {
        parsed = null;
      }
      const overflow = {
        stdout: stdoutBytes > job.limits.maxOutputBytes,
        stderr: stderrBytes > job.limits.maxOutputBytes,
      };
      if (killedBy !== "") {
        resolve({
          status: killedBy === "timeout" ? "timeout" : "canceled",
          message:
            killedBy === "timeout"
              ? "The sandbox program exceeded its wall-clock limit and was killed."
              : "The sandbox run was canceled.",
          stdout: "",
          stderr: stderrText,
          exitCode,
          truncated: { stdout: false, stderr: overflow.stderr },
          durationMs,
          artifacts: [],
        });
        return;
      }
      if (!parsed || typeof parsed.status !== "string") {
        resolve({
          status: exitCode === 137 ? "quota" : "unavailable",
          message:
            exitCode === 137
              ? "The sandbox exceeded its memory limit and was terminated."
              : `The sandbox worker did not return a valid result (container exit ${exitCode}).`,
          stdout: "",
          stderr: stderrText,
          exitCode,
          truncated: overflow,
          durationMs,
          artifacts: parsed?.artifacts?.slice(0, MAX_ARTIFACTS) ?? [],
        });
        return;
      }
      const workerStdout = parsed.stdout ?? "";
      resolve({
        status: parsed.status,
        ...(parsed.message ? { message: parsed.message } : {}),
        stdout: workerStdout,
        stderr: parsed.stderr ?? stderrText,
        exitCode,
        truncated: {
          stdout: workerStdout.length >= job.limits.maxOutputBytes,
          stderr: overflow.stderr,
        },
        durationMs,
        artifacts: parsed.artifacts?.slice(0, MAX_ARTIFACTS) ?? [],
      });
    });
    child.stdin.end(request);
    return promise;
  }

  protected spawnProcess(
    argv: string[],
  ): ChildProcessWithoutNullStreams {
    return spawn(this.dockerPath, argv, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}
