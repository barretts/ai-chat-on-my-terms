import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  createMockHostedSearchUpstream,
  HostedSearchService,
} from "@locallab/tools-hosted-search";
import { registerHostedSearchRoute } from "./index.js";

const upstream = createMockHostedSearchUpstream({
  weather: [
    {
      title: "Forecast",
      url: "https://example.com/forecast",
      snippet: "Sunny.",
    },
  ],
});

test("search route maps success and every structured failure", async () => {
  const app = Fastify({ logger: false });
  const service = new HostedSearchService({
    enabled: true,
    upstream,
    maxRequestsPerWindow: 2,
    windowMs: 60_000,
  });
  registerHostedSearchRoute(app, service);

  const ok = await app.inject({ method: "GET", url: "/search?q=weather" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  assert.equal(ok.json().sources.length, 1);

  const second = await app.inject({ method: "GET", url: "/search?q=weather" });
  assert.equal(second.statusCode, 200);
  const limited = await app.inject({
    method: "GET",
    url: "/search?q=weather",
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "limit-reached");

  const bad = await app.inject({ method: "GET", url: "/search?q=" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "malformed-query");

  const disabledApp = Fastify({ logger: false });
  registerHostedSearchRoute(
    disabledApp,
    new HostedSearchService({ enabled: false, upstream }),
  );
  const disabled = await disabledApp.inject({
    method: "GET",
    url: "/search?q=weather",
  });
  assert.equal(disabled.statusCode, 403);

  const unconfiguredApp = Fastify({ logger: false });
  registerHostedSearchRoute(
    unconfiguredApp,
    new HostedSearchService({ enabled: true }),
  );
  const unconfigured = await unconfiguredApp.inject({
    method: "GET",
    url: "/search?q=weather",
  });
  assert.equal(unconfigured.statusCode, 409);
  assert.match(unconfigured.json().message, /no upstream is configured/);
});
