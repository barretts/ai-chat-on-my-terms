import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";
import { registerSandboxRoute } from "./index.js";
import { DockerSandboxRunner } from "@locallab/tools-sandbox";

const build = (runner?: Parameters<typeof registerSandboxRoute>[1]) => {
  const app = Fastify();
  registerSandboxRoute(app, runner);
  return app;
};

test("sandbox route validates jobs and surfaces unavailability", async () => {
  const app = build();
  const malformed = await app.inject({
    method: "POST",
    url: "/sandbox/run",
    payload: { language: "python" },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, "malformed-job");

  const invalid = await app.inject({
    method: "POST",
    url: "/sandbox/run",
    payload: {
      language: "python",
      code: "print(1)",
      limits: { timeoutMs: 1000, maxOutputBytes: 10, memoryMb: 4096 },
    },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "invalid-limits");

  const down = build(
    new DockerSandboxRunner("locallab/sandbox-worker:0.1.0", "definitely-not-docker"),
  );
  const unavailable = await down.inject({
    method: "POST",
    url: "/sandbox/run",
    payload: {
      language: "javascript",
      code: "console.log(1)",
      limits: { timeoutMs: 5000, maxOutputBytes: 512 },
    },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().code, "unavailable");
  assert.match(unavailable.json().message, /Sandbox runner unavailable/);
});
