// Sandbox worker: reads one job JSON on stdin, runs the program with the
// selected language, and writes exactly one result JSON on stdout.
// Container flags (no network, read-only rootfs, memory/CPU/PID caps) are
// enforced by the caller; this layer enforces wall-clock time, output
// ceilings, and artifact collection.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";

const MAX_JOB_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024;

function emit(result) {
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_JOB_BYTES)
      emit({
        status: "quota",
        message: "The sandbox job request exceeded the size limit.",
        stdout: "",
        stderr: "",
        artifacts: [],
      });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
let job;
try {
  job = JSON.parse(raw);
} catch {
  emit({
    status: "unavailable",
    message: "The sandbox job request was not valid JSON.",
    stdout: "",
    stderr: "",
    artifacts: [],
  });
}
const languages = {
  python: ["python3", "prog.py"],
  javascript: ["node", "prog.mjs"],
};
const runtime = languages[job.language];
if (!runtime || typeof job.code !== "string" || job.code.trim() === "") {
  emit({
    status: "unavailable",
    message: "The sandbox job did not name a supported language.",
    stdout: "",
    stderr: "",
    artifacts: [],
  });
}
const programPath = path.join("/work", runtime[1]);
writeFileSync(programPath, job.code, { mode: 0o600 });
const timeoutMs =
  Number.isInteger(job.timeoutMs) && job.timeoutMs > 0 ? job.timeoutMs : 30_000;
const maxOutput =
  Number.isInteger(job.maxOutputBytes) && job.maxOutputBytes > 0
    ? job.maxOutputBytes
    : 64 * 1024;

const child = spawn(runtime[0], [programPath, ...(job.args ?? [])], {
  cwd: "/work",
  stdio: ["pipe", "pipe", "pipe"],
});
let stdoutBytes = 0;
let stderrBytes = 0;
let out = "";
let err = "";
let timedOut = false;
const timer = setTimeout(
  () => {
    timedOut = true;
    child.kill("SIGKILL");
  },
  Math.min(timeoutMs, 120_000),
);
child.stdout.on("data", (chunk) => {
  stdoutBytes += chunk.length;
  if (Buffer.byteLength(out, "utf8") < maxOutput) out += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderrBytes += chunk.length;
  if (Buffer.byteLength(err, "utf8") < maxOutput) err += chunk.toString("utf8");
});
if (typeof job.stdin === "string") child.stdin.end(job.stdin);
else child.stdin.end();

const { promise: closedPromise, resolve: closedResolve } =
  Promise.withResolvers();
child.on("close", (code, signal) => closedResolve({ code, signal }));
const closed = await closedPromise;
clearTimeout(timer);

if (timedOut) {
  emit({
    status: "timeout",
    message:
      "The sandbox program exceeded its wall-clock limit and was killed.",
    stdout: out,
    stderr: err,
    exitCode: closed.code,
    artifacts: [],
  });
}

const artifacts = [];
if (Array.isArray(job.artifactNames)) {
  for (const name of job.artifactNames.slice(0, 8)) {
    if (!/^[\w.-]{1,64}$/.test(name)) continue;
    const file = path.join("/work", "out", name);
    let size = 0;
    try {
      size = statSync(file).size;
      const buf = readFileSync(file);
      const kept = buf.subarray(0, MAX_ARTIFACT_BYTES);
      artifacts.push({
        name,
        bytes: size,
        base64: kept.toString("base64"),
        truncated: size > kept.length,
      });
    } catch {
      // Missing artifact files are simply not reported.
    }
  }
}

const status =
  closed.code === 0
    ? "ok"
    : closed.signal === "SIGKILL"
      ? "quota"
      : "runtime-error";
emit({
  status,
  ...(status === "runtime-error"
    ? {
        message: `The sandbox program exited with code ${closed.code}.`,
      }
    : status === "quota"
      ? {
          message:
            "The sandbox program was killed by the runtime (memory or process limit).",
        }
      : {}),
  stdout: out,
  stderr: err,
  exitCode: closed.code,
  artifacts,
});
