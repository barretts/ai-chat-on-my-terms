import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SearxngClient,
  SearxngError,
  normalizeSearxngBaseUrl,
  searxngErrorResult,
} from "../src/index";

type FixtureHandler = (req: IncomingMessage, res: ServerResponse) => void;

interface Fixture {
  origin: string;
  requests: Array<{
    path: string | undefined;
    url: string | null;
    authorization: string | null;
    xCustom: string | null;
  }>;
}

const servers: http.Server[] = [];

async function startFixture(handler: FixtureHandler): Promise<Fixture> {
  const fixture: Fixture = { origin: "", requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorization = req.headers.authorization;
    const custom = req.headers["x-custom"];
    fixture.requests.push({
      path: url.pathname,
      url: typeof req.url === "string" ? req.url : null,
      authorization: typeof authorization === "string" ? authorization : null,
      xCustom: typeof custom === "string" ? custom : null,
    });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture server did not bind an ephemeral port");
  fixture.origin = `http://127.0.0.1:${address.port}`;
  return fixture;
}

afterAll(() => {
  for (const server of servers) server.close();
});

function jsonHandler(payload: unknown): FixtureHandler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
}

/** Runs a search and returns the rejected SearxngError; fails the test if
 * the search unexpectedly succeeds or throws something else. */
async function searchFailure(
  client: SearxngClient,
  query: string,
  signal?: AbortSignal,
): Promise<SearxngError> {
  try {
    await client.search(query, signal ?? new AbortController().signal);
  } catch (cause) {
    if (cause instanceof SearxngError) return cause;
    throw cause;
  }
  throw new Error("expected the search to fail");
}

describe("normalizeSearxngBaseUrl", () => {
  it("accepts absolute http(s) URLs and canonicalizes them", () => {
    expect(normalizeSearxngBaseUrl("http://127.0.0.1:8888")).toBe(
      "http://127.0.0.1:8888",
    );
    expect(normalizeSearxngBaseUrl("https://s.example/searxng")).toBe(
      "https://s.example/searxng",
    );
    expect(normalizeSearxngBaseUrl("https://s.example/searxng/")).toBe(
      "https://s.example/searxng",
    );
  });
  it("rejects non-http(s) protocols with an honest message", () => {
    let thrown: unknown;
    try {
      normalizeSearxngBaseUrl("ftp://x");
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SearxngError);
    const error = thrown as SearxngError;
    expect(error.code).toBe("malformed-config");
    expect(error.message).toContain("http or https");
  });
  it("rejects non-absolute inputs with an honest message", () => {
    let thrown: unknown;
    try {
      normalizeSearxngBaseUrl("not a url");
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SearxngError);
    const error = thrown as SearxngError;
    expect(error.code).toBe("malformed-config");
    expect(error.message).toContain("not an absolute URL");
  });
  it("rejects credentials embedded in the URL", () => {
    let thrown: unknown;
    try {
      normalizeSearxngBaseUrl("http://u:p@host");
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SearxngError);
    const error = thrown as SearxngError;
    expect(error.code).toBe("malformed-config");
    expect(error.message).toContain("credentials");
  });
  it("searxngErrorResult maps malformed-config honestly", () => {
    let thrown: unknown;
    try {
      normalizeSearxngBaseUrl("ftp://x");
    } catch (cause) {
      thrown = cause;
    }
    const result = searxngErrorResult(thrown);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "malformed-config",
        message: expect.stringContaining("http or https"),
        recoverable: false,
      },
    });
  });
});

describe("SearxngClient.search success paths", () => {
  it("maps results in server order with params and headers forwarded", async () => {
    const fixture = await startFixture(
      jsonHandler({
        results: [
          {
            title: "Alpha",
            url: "https://a.example/doc",
            content: "first snippet",
            engine: "google",
            score: 3.5,
          },
          { title: "Beta", url: "http://b.example/x", content: "second" },
        ],
      }),
    );
    const client = new SearxngClient({
      baseUrl: fixture.origin,
      headers: { Authorization: "Bearer test-token", "x-custom": "abc" },
      language: "en",
      categories: "general,news",
    });
    const outcome = await client.search("local lab", new AbortController().signal);
    expect(outcome.dropped).toBe(0);
    expect(outcome.results).toEqual([
      {
        title: "Alpha",
        url: "https://a.example/doc",
        text: "first snippet",
        engine: "google",
        score: 3.5,
      },
      { title: "Beta", url: "http://b.example/x", text: "second" },
    ]);
    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0];
    if (!request) throw new Error("fixture recorded no request");
    expect(request.path).toBe("/search");
    expect(request.url).toBe(
      "/search?q=local+lab&format=json&language=en&categories=general%2Cnews",
    );
    expect(request.authorization).toBe("Bearer test-token");
    expect(request.xCustom).toBe("abc");
  });
  it("treats an empty results array as success, not an error", async () => {
    const fixture = await startFixture(jsonHandler({ results: [] }));
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const outcome = await client.search("nothing", new AbortController().signal);
    expect(outcome).toEqual({ results: [], dropped: 0 });
  });
  it("appends /search to a path-prefixed base URL", async () => {
    const fixture = await startFixture(jsonHandler({ results: [] }));
    const client = new SearxngClient({ baseUrl: `${fixture.origin}/searxng/` });
    await client.search("q", new AbortController().signal);
    expect(fixture.requests[0]?.path).toBe("/searxng/search");
  });
  it("follows same-origin redirects and keeps headers on them", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url?.startsWith("/old/search?") && req.headers.authorization) {
        res.writeHead(302, { location: "/search?q=hop&format=json" });
        res.end();
        return;
      }
      jsonHandler({
        results: [{ title: "Moved", url: "https://m.example", content: "" }],
      })(req, res);
    });
    const client = new SearxngClient({
      baseUrl: `${fixture.origin}/old`,
      headers: { Authorization: "Bearer hop" },
    });
    const outcome = await client.search("hop", new AbortController().signal);
    expect(outcome.results[0]?.title).toBe("Moved");
    expect(fixture.requests.map((request) => request.path)).toEqual([
      "/old/search",
      "/search",
    ]);
    expect(fixture.requests[1]?.authorization).toBe("Bearer hop");
  });
  it("sanitizes control characters and bounds titles to 200 chars", async () => {
    const fixture = await startFixture(
      jsonHandler({
        results: [
          {
            title: `One\u0001Two ${"x".repeat(300)}`,
            url: "https://s.example",
            content: "tab\there",
          },
        ],
      }),
    );
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const outcome = await client.search("q", new AbortController().signal);
    const result = outcome.results[0];
    if (!result) throw new Error("result was dropped");
    expect(result.title).toContain("One Two");
    expect(result.title.length).toBe(200);
    expect(result.title).not.toContain("\u0001");
    expect(result.text).toBe("tab here");
  });
});

describe("SearxngClient bounding", () => {
  it("keeps at most maxResults (default 10) and counts dropped", async () => {
    const many = Array.from({ length: 50 }, (_unused, index) => ({
      title: `Result ${index}`,
      url: `https://e.example/${index}`,
      content: "snippet",
    }));
    const fixture = await startFixture(jsonHandler({ results: many }));
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const outcome = await client.search("many", new AbortController().signal);
    expect(outcome.results).toHaveLength(10);
    expect(outcome.results[0]?.title).toBe("Result 0");
    expect(outcome.dropped).toBe(40);
  });
  it("caps maxResults at 20 regardless of config", async () => {
    const many = Array.from({ length: 25 }, (_unused, index) => ({
      title: `Result ${index}`,
      url: `https://e.example/${index}`,
    }));
    const fixture = await startFixture(jsonHandler({ results: many }));
    const client = new SearxngClient({
      baseUrl: fixture.origin,
      maxResults: 25,
    });
    const outcome = await client.search("many", new AbortController().signal);
    expect(outcome.results).toHaveLength(20);
    expect(outcome.dropped).toBe(5);
  });
  it("truncates text at whole characters under maxTextBytes", async () => {
    const fixture = await startFixture(
      jsonHandler({
        results: [
          {
            title: "Long",
            url: "https://t.example",
            content: "語".repeat(10),
          },
        ],
      }),
    );
    const client = new SearxngClient({
      baseUrl: fixture.origin,
      maxTextBytes: 8,
    });
    const outcome = await client.search("q", new AbortController().signal);
    expect(outcome.results[0]?.text).toBe("語語");
  });
  it("drops non-http(s) and unparseable result urls, counted", async () => {
    const fixture = await startFixture(
      jsonHandler({
        results: [
          { title: "Ftp", url: "ftp://x.example/file", content: "x" },
          { title: "Garbage", url: "not a url", content: "x" },
          { title: "Relative", url: "/rel/path", content: "x" },
        ],
      }),
    );
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const outcome = await client.search("q", new AbortController().signal);
    expect(outcome.results).toEqual([]);
    expect(outcome.dropped).toBe(3);
  });
  it("drops entries missing url or title, counted", async () => {
    const fixture = await startFixture(
      jsonHandler({
        results: [
          { url: "https://ok.example", content: "no title" },
          { title: "No url", content: "x" },
          { title: "", url: "https://empty.example", content: "x" },
          "not even an object",
        ],
      }),
    );
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const outcome = await client.search("q", new AbortController().signal);
    expect(outcome.results).toEqual([]);
    expect(outcome.dropped).toBe(4);
  });
});

describe("SearxngClient error classification", () => {
  it("rejects invalid JSON bodies as malformed", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json at all");
    });
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("malformed");
    expect(error.message).toContain("invalid JSON");
  });
  it("rejects payloads without a results array as malformed", async () => {
    const fixture = await startFixture(jsonHandler({ result: [] }));
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("malformed");
    expect(error.message).toContain("results");
  });
  it("classifies an HTML 200 answer as unsupported naming format=json", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>web ui</body></html>");
    });
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("unsupported");
    expect(error.message).toContain("format=json");
  });
  it("classifies 403 with an HTML page as unsupported, not auth", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html>access denied</html>");
    });
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("unsupported");
    expect(error.message).toContain("format=json");
  });
  it("classifies 401 as auth", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unauthorized"}');
    });
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("auth");
  });
  it("classifies 429 as ratelimited", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end("{}");
    });
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("ratelimited");
  });
  it("classifies other non-2xx as malformed with the status", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("malformed");
    expect(error.message).toContain("500");
  });
  it("classifies a closed port as offline", async () => {
    const client = new SearxngClient({ baseUrl: "http://127.0.0.1:39113" });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("offline");
  });
  it("classifies caller cancellation as canceled", async () => {
    const fixture = await startFixture(() => {
      // deliberately never answers
    });
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const controller = new AbortController();
    controller.abort();
    const error = await searchFailure(client, "q", controller.signal);
    expect(error.code).toBe("canceled");
    expect(error.message).toContain("canceled");
  });
  it("classifies the internal deadline as timeout", async () => {
    const fixture = await startFixture(() => {
      // deliberately never answers
    });
    const client = new SearxngClient({
      baseUrl: fixture.origin,
      timeoutMs: 5,
    });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("5 ms");
  });
  it("refuses a cross-origin redirect without contacting the foreign origin", async () => {
    const foreign = await startFixture(
      jsonHandler({ results: [{ title: "leak", url: "https://leak.example" }] }),
    );
    const home = await startFixture((_req, res) => {
      res.writeHead(302, { location: `${foreign.origin}/search` });
      res.end();
    });
    const client = new SearxngClient({
      baseUrl: home.origin,
      headers: { Authorization: "Bearer secret" },
    });
    const error = await searchFailure(client, "q");
    expect(error.code).toBe("unsupported");
    expect(error.message).toContain("foreign origin");
    expect(foreign.requests).toHaveLength(0);
    expect(home.requests).toHaveLength(1);
  });
  it("searxngErrorResult maps error codes with honest recoverability", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
    });
    const client = new SearxngClient({ baseUrl: fixture.origin });
    const authFailure = searxngErrorResult(await searchFailure(client, "q"));
    expect(authFailure).toEqual({
      ok: false,
      error: { code: "auth", message: expect.any(String), recoverable: false },
    });
    const canceled = searxngErrorResult(
      new SearxngError("canceled", "The SearXNG request was canceled."),
    );
    expect(canceled.error.code).toBe("canceled");
    expect(canceled.error.recoverable).toBe(true);
    const rawFailure = searxngErrorResult(new TypeError("fetch failed"));
    expect(rawFailure.error.code).toBe("offline");
    expect(
      searxngErrorResult(Object.assign(new Error("x"), { name: "AbortError" }))
        .error,
    ).toMatchObject({ code: "canceled", recoverable: true });
  });
});
