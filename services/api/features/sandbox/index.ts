import type { FastifyInstance } from "fastify";
import {
  DockerSandboxRunner,
  validateSandboxJob,
  type SandboxJob,
  type SandboxRunner,
} from "@locallab/tools-sandbox";

/** Optional sandbox service (TL-08): exposes language jobs over HTTP.
 * Authentication is owned by the service layer in front; this route only
 * validates the job shape and maps runner outcomes. Programs and outputs
 * are returned to the caller, never logged. */
export function registerSandboxRoute(
  app: FastifyInstance,
  runner: SandboxRunner = new DockerSandboxRunner("locallab/sandbox-worker:0.1.0"),
): void {
  app.post("/sandbox/run", async (request, reply) => {
    const body = request.body as Partial<SandboxJob> | undefined;
    if (
      !body ||
      (body.language !== "python" && body.language !== "javascript") ||
      typeof body.code !== "string" ||
      !body.limits ||
      typeof body.limits.timeoutMs !== "number" ||
      typeof body.limits.maxOutputBytes !== "number"
    ) {
      void reply.status(400);
      return {
        ok: false,
        code: "malformed-job",
        message:
          "Expected { language: python|javascript, code, limits: " +
          "{ timeoutMs, maxOutputBytes } }.",
      };
    }
    const job = body as SandboxJob;
    try {
      validateSandboxJob(job);
    } catch (error) {
      void reply.status(400);
      return {
        ok: false,
        code: "invalid-limits",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const result = await runner.run(job);
      return { ok: true, ...result };
    } catch (error) {
      void reply.status(503);
      return {
        ok: false,
        code: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
