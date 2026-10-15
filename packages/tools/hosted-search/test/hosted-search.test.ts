import assert from "node:assert/strict";
import test from "node:test";
import {
  createMockHostedSearchUpstream,
  HostedSearchError,
  HostedSearchService,
  type HostedSearchErrorCode,
} from "../src/index.js";

const upstream = createMockHostedSearchUpstream({
  "local lab news": [
    {
      title: "Local Lab release",
      url: "https://example.com/release",
      snippet: "Notes about the release.",
    },
    { title: "bad link", url: "javascript:alert(1)", snippet: "nope" },
    {
      title: "Second source",
      url: "https://example.org/second",
      snippet: "Second snippet.",
    },
  ],
});

async function expectCode(
  run: () => Promise<unknown>,
  code: HostedSearchErrorCode,
): Promise<HostedSearchError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HostedSearchError);
    assert.equal(error.code, code);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${code} failure` });
}

test("enabled upstream path returns structured sources without bad rows", async () => {
  const logged: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => logged.push(String(args[0]));
  console.error = (...args: unknown[]) => logged.push(String(args[0]));
  try {
    const service = new HostedSearchService({
      enabled: true,
      upstream,
      maxRequestsPerWindow: 5,
    });
    const outcome = await service.search("Local Lab news");
    assert.equal(outcome.provider, "mock");
    assert.deepEqual(
      outcome.sources.map((source) => source.url),
      ["https://example.com/release", "https://example.org/second"],
    );
    assert.equal(outcome.dropped, 1, "non-http URL dropped and counted");
    assert.deepEqual(logged, [], "no query or payload logging");
  } finally {
    console.log = realLog;
    console.error = realError;
  }
});

test("explicit missing-upstream configuration state", async () => {
  const service = new HostedSearchService({ enabled: true });
  assert.deepEqual(service.status(), {
    enabled: true,
    configured: false,
    provider: null,
  });
  const error = await expectCode(
    () => service.search("anything"),
    "not-configured",
  );
  assert.match(error.message, /no upstream is configured/);
});

test("disabled search never runs and never falls back", async () => {
  const service = new HostedSearchService({ enabled: false, upstream });
  await expectCode(() => service.search("anything"), "disabled");
});

test("account limits are enforced locally with retry timing", async () => {
  const service = new HostedSearchService({
    enabled: true,
    upstream,
    maxRequestsPerWindow: 2,
    windowMs: 60_000,
  });
  await service.search("local lab news");
  await service.search("local lab news");
  const error = await expectCode(
    () => service.search("local lab news"),
    "limit-reached",
  );
  assert.ok(
    error.retryAfterMs !== undefined && error.retryAfterMs > 0,
    "retryAfterMs surfaces",
  );
});

test("upstream failures are structured and never echoed verbatim", async () => {
  const service = new HostedSearchService({
    enabled: true,
    upstream: {
      name: "flaky",
      search: async () => {
        throw new Error("upstream internal detail");
      },
    },
  });
  const error = await expectCode(() => service.search("q"), "upstream");
  assert.match(error.message, /^The hosted search upstream failed: /);
});

test("unknown mock queries return zero sources, never guesses", async () => {
  const service = new HostedSearchService({ enabled: true, upstream });
  const outcome = await service.search("nothing in the fixture table");
  assert.deepEqual(outcome.sources, []);
});
