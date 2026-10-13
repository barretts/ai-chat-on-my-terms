import { expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HostScopedSecretStore,
  type SecretRef,
} from "@locallab/security-secrets";
import { createSearxngResearchClient } from "./searxng-web-search";
import { WebResearchError, type WebSource } from "./web-research";

let requests: string[] = [];
let authSeen: (string | null)[] = [];

async function listen(
  onRequest: Parameters<typeof createServer>[0],
): Promise<{ server: Server; url: string; stop: () => Promise<void> }> {
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    authSeen.push(request.headers.authorization ?? null);
    onRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function keyStore() {
  const store = new Map<string, string>();
  return new HostScopedSecretStore(
    {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
    },
    "searxng-test",
    () => "00000000-0000-4000-8000-000000000001",
  );
}

/** Any public search here would be a silent fallback, so it always fails. */
function noFallbackClient() {
  return {
    search: async (): Promise<WebSource[]> => {
      throw new Error("public search must never run for a configured service");
    },
    fetchPage: async (input: string): Promise<WebSource> => ({
      url: input,
      title: "public page",
      text: "page excerpt",
      kind: "page-excerpt",
    }),
  };
}

function client(endpoint: string | null, secrets = keyStore(), credentialRef: SecretRef | null = null, extra: { timeoutMs?: number } = {}) {
  return createSearxngResearchClient({
    publicClient: noFallbackClient(),
    secrets,
    credentialRef,
    endpoint,
    fetcher: fetch,
    ...extra,
  });
}

it("maps SearXNG results into research sources from the configured server only", async () => {
  requests = [];
  authSeen = [];
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        query: "local lab",
        results: [
          {
            title: "First <b>hit</b>",
            url: "https://example.com/first",
            content: "Alpha <em>snippet</em> text",
            engine: "duckduckgo",
            score: 3,
          },
          {
            title: "Second hit",
            url: "https://example.com/second",
            content: "Beta snippet",
          },
          // A result pointing at a local host must never reach research.
          {
            title: "Local result",
            url: "http://127.0.0.1:9999/private",
            content: "must be dropped",
          },
          {
            title: "",
            url: "https://example.com/no-title",
            content: "dropped: missing title",
          },
        ],
      }),
    );
  });
  try {
    const sources = await client(fixture.url).search("local lab", new AbortController().signal);
    expect(requests.length).toBe(1);
    expect(requests[0]).toContain("/search?");
    expect(requests[0]).toContain("format=json");
    expect(sources).toEqual([
      {
        url: "https://example.com/first",
        title: "First hit",
        text: "Alpha snippet text",
        kind: "search-snippet",
      },
      {
        url: "https://example.com/second",
        title: "Second hit",
        text: "Beta snippet",
        kind: "search-snippet",
      },
    ]);
  } finally {
    await fixture.stop();
  }
});

it("returns an empty list for an honest empty result without calling public search", async () => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [] }));
  });
  try {
    expect(
      await client(fixture.url).search("nothing matches", new AbortController().signal),
    ).toEqual([]);
  } finally {
    await fixture.stop();
  }
});

it("reports every configured-server failure honestly and never falls back", async () => {
  const cases: [number, string, WebResearchError["reason"]][] = [
    [401, JSON.stringify({ error: "unauthorized" }), "http"],
    [429, JSON.stringify({ results: [] }), "rate-limit"],
    [200, "not json at all {{{", "unreadable"],
    [200, "<html><body>JSON API disabled</body></html>", "unreadable"],
  ];
  for (const [status, body, reason] of cases) {
    const fixture = await listen((_request, response) => {
      response.writeHead(status, {
        "content-type": status === 200 && body.startsWith("<html>") ? "text/html" : "application/json",
      });
      response.end(body);
    });
    try {
      await expect(
        client(fixture.url).search("query", new AbortController().signal),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof WebResearchError &&
          error.reason === reason &&
          !/fallback/i.test(error.message),
      );
    } finally {
      await fixture.stop();
    }
  }
  await expect(
    client("http://127.0.0.1:39112").search("query", new AbortController().signal),
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof WebResearchError && error.reason === "network",
  );
  const silent = await listen(() => undefined);
  try {
    await expect(
      client(silent.url, keyStore(), null, { timeoutMs: 20 }).search(
        "query",
        new AbortController().signal,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WebResearchError && error.reason === "timeout",
    );
  } finally {
    await silent.stop();
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    client("http://127.0.0.1:39112").search("query", cancelled.signal),
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof WebResearchError && error.reason === "canceled",
  );
});

it("requires a saved server address before any request", () => {
  requests = [];
  expect(() => client(null)).toThrow(WebResearchError);
  expect(requests.length).toBe(0);
});

it("sends a saved SearXNG key only to the endpoint origin and none to a foreign key", async () => {
  requests = [];
  authSeen = [];
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [] }));
  });
  try {
    const secrets = keyStore();
    const own = await secrets.put(fixture.url, "authorization", "Bearer searxng-fixture-key");
    const results = await client(fixture.url, secrets, own.ref).search(
      "query",
      new AbortController().signal,
    );
    expect(results).toEqual([]);
    expect(authSeen).toEqual(["Bearer searxng-fixture-key"]);
    authSeen = [];
    // A key stored for another server (for example Brave) must not travel here.
    const foreign = await secrets.put(
      "https://api.search.brave.com",
      "x-subscription-token",
      "brave-fixture-token",
    );
    await client(fixture.url, secrets, foreign.ref).search(
      "query",
      new AbortController().signal,
    );
    expect(authSeen).toEqual([null]);
  } finally {
    await fixture.stop();
  }
});

it("keeps page reads on the credential-free public client", async () => {
  const source = await client("http://127.0.0.1:39112").fetchPage(
    "https://example.com/page",
    new AbortController().signal,
  );
  expect(source.kind).toBe("page-excerpt");
});
