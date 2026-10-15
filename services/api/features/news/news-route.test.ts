import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  createMockHostedSearchUpstream,
  HostedSearchService,
  type HostedSearchUpstreamResponse,
} from "@locallab/tools-hosted-search";
import { NewsBriefingService, registerNewsBriefingRoute } from "./index.js";

class CountingUpstream {
  calls = 0;
  constructor(
    private readonly inner: ReturnType<typeof createMockHostedSearchUpstream>,
  ) {}
  get name(): string {
    return this.inner.name;
  }
  async search(
    query: string,
    options: { maxResults: number; signal?: AbortSignal },
  ): Promise<HostedSearchUpstreamResponse> {
    this.calls += 1;
    return await this.inner.search(query, options);
  }
}

const FIXTURES = {
  "transit in seattle": [
    {
      title: "Tunnel reopens",
      url: "https://example.com/tunnel",
      snippet: "The tunnel reopened Monday.",
    },
    {
      title: "Fares flat",
      url: "https://example.com/fares",
      snippet: "Fares stay unchanged.",
    },
  ],
};

test("briefing composes from fixture sources and caches with freshness", async () => {
  let now = 1_000;
  const upstream = new CountingUpstream(createMockHostedSearchUpstream(FIXTURES));
  const app = Fastify({ logger: false });
  const service = new NewsBriefingService(
    new HostedSearchService({ enabled: true, upstream }),
    { maxAgeMs: 3_600_000, now: () => now },
  );
  registerNewsBriefingRoute(app, service);

  const first = await app.inject({
    method: "GET",
    url: "/news/brief?q=transit%20in%20seattle",
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().ok, true);
  assert.equal(first.json().cached, false);
  assert.equal(first.json().briefing.sources.length, 2);
  assert.match(first.json().briefing.summary, /Tunnel reopens/);
  assert.equal(first.json().briefing.generatedAt, 1_000);

  now = 2_000;
  const second = await app.inject({
    method: "GET",
    url: "/news/brief?q=Transit%20in%20Seattle",
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().cached, true);
  assert.equal(upstream.calls, 1);

  now = 1_000 + 3_600_001;
  const third = await app.inject({
    method: "GET",
    url: "/news/brief?q=transit%20in%20seattle",
  });
  assert.equal(third.statusCode, 200);
  assert.equal(third.json().cached, false);
  assert.equal(upstream.calls, 2);
  assert.equal(third.json().briefing.generatedAt, 1_000 + 3_600_001);
});

test("disabled provider is explicit; unconfigured never fakes a brief", async () => {
  const upstream = createMockHostedSearchUpstream(FIXTURES);
  const disabledApp = Fastify({ logger: false });
  registerNewsBriefingRoute(
    disabledApp,
    new NewsBriefingService(
      new HostedSearchService({ enabled: false, upstream }),
      { maxAgeMs: 1000, now: () => 0 },
    ),
  );
  const disabled = await disabledApp.inject({
    method: "GET",
    url: "/news/brief?q=transit%20in%20seattle",
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.json().code, "disabled");

  const unconfiguredApp = Fastify({ logger: false });
  registerNewsBriefingRoute(
    unconfiguredApp,
    new NewsBriefingService(
      new HostedSearchService({ enabled: true }),
      { maxAgeMs: 1000, now: () => 0 },
    ),
  );
  const unconfigured = await unconfiguredApp.inject({
    method: "GET",
    url: "/news/brief?q=transit%20in%20seattle",
  });
  assert.equal(unconfigured.statusCode, 409);
  assert.equal(unconfigured.json().ok, false);

  const malformed = await disabledApp.inject({
    method: "GET",
    url: "/news/brief?q=",
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, "malformed-query");
});
