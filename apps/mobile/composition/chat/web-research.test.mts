import { expect, it, vi } from "vitest";
import {
  RunEventBatchSchema,
  type RunRequest,
  type RunEvent,
} from "@locallab/contracts/run-events";
import type { ProviderPort } from "@locallab/contracts/ports";
import {
  createWebResearchClient,
  linksInMessage,
  parseSearchResults,
  publicPageUrl,
  withWebResearch,
} from "./web-research";
import { toRecoverableChatError } from "@locallab/chat-integration";

const html = `<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.expo.dev%2F">Expo &amp; docs</a><a class="result__snippet">Official <b>documentation</b>.</a></div>
<a class="result__a" href="https://example.com/article">Example</a><span class="result__snippet">Second result.</span>
<a class="result__a" href="http://127.0.0.1/">Not public</a>`;
const request: RunRequest = {
  runId: "00000000-0000-7000-8000-000000000001",
  conversationId: "00000000-0000-7000-8000-000000000002",
  messageId: "00000000-0000-7000-8000-000000000003",
  providerConnectionId: "00000000-0000-7000-8000-000000000004",
  modelId: "local-coder",
  context: [
    { kind: "system", value: "Be helpful" },
    { kind: "user", value: "Question" },
  ],
  parameters: {},
  permittedTools: [],
  attachmentRefs: [],
  reasoning: false,
  json: false,
};
const signal = () => new AbortController().signal;
let id = 10;
const createId = () =>
  `00000000-0000-7000-8000-${String(id++).padStart(12, "0")}`;
async function collect(provider: ProviderPort, abort = signal()) {
  const events = [];
  for await (const event of provider.startRun(request, abort))
    events.push(event);
  RunEventBatchSchema.parse(events);
  return events;
}
function fakeProvider(
  receive: (value: RunRequest) => void = () => {},
): ProviderPort {
  return {
    listModels: async () => ({ ok: true, value: ["local-coder"] }),
    getCapabilities: async () => ({ ok: true, value: { tools: "no" } }),
    async *startRun(input) {
      receive(input);
      for (const [sequence, payload] of [
        { type: "RunStarted" },
        { type: "TextDelta", text: "Answer" },
        { type: "RunCompleted" },
      ].entries())
        yield {
          ...payload,
          runId: input.runId,
          sequence,
          timestamp: new Date().toISOString(),
        } as RunEvent;
    },
  };
}

it("reads public search snippets, unwraps redirect URLs, decodes HTML and excludes private results", () => {
  expect(parseSearchResults(html)).toEqual([
    {
      url: "https://docs.expo.dev/",
      title: "Expo & docs",
      text: "Official documentation.",
      kind: "search-snippet",
    },
    {
      url: "https://example.com/article",
      title: "Example",
      text: "Second result.",
      kind: "search-snippet",
    },
  ]);
  expect(() =>
    parseSearchResults('<form id="challenge-form">bots use DuckDuckGo</form>'),
  ).toThrow(/verification/);
  expect(parseSearchResults("No results found")).toEqual([]);
  expect(() => parseSearchResults("<html>Unexpected</html>")).toThrow(
    /unreadable/,
  );
});
it("rejects private addresses and credentials while normalizing public links", () => {
  for (const url of [
    "http://127.0.0.1",
    "http://192.168.1.213",
    "http://[::1]",
    "http://0x7f000001",
    "http://2130706433",
    "http://laptop.local",
    "http://localhost",
    "file:///etc/passwd",
    "https://user:password@example.com",
    "https://example.com:444",
  ])
    expect(() => publicPageUrl(url)).toThrow();
  expect(
    linksInMessage(
      "Read https://example.com/article. Then (https://docs.expo.dev/) and https://example.com/article.",
    ),
  ).toEqual(["https://example.com/article", "https://docs.expo.dev/"]);
});
it("only contacts research services with omitted credentials and a bounded page excerpt", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createWebResearchClient(async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(
      String(url).includes("duckduckgo")
        ? html
        : `Title: Page\nURL Source: https://example.com/\nMarkdown Content:\n${"Content ".repeat(3000)}`,
    );
  });
  expect((await client.search("Expo", signal())).length).toBe(2);
  const page = await client.fetchPage("https://example.com", signal());
  expect(page.text.length).toBe(12000);
  expect(calls.map((call) => new URL(call.url).hostname)).toEqual([
    "html.duckduckgo.com",
    "r.jina.ai",
  ]);
  expect(
    calls.every(
      (call) =>
        call.init?.credentials === "omit" &&
        call.init?.redirect === "error" &&
        new Headers(call.init?.headers).get("accept") ===
          (call.url.includes("r.jina.ai") ? "application/json" : "text/html"),
    ),
  ).toBe(true);
});
it("keeps timeouts active through slow bodies and reports service errors without requesting the model", async () => {
  const client = createWebResearchClient(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
    5,
  );
  await expect(client.search("Question", signal())).rejects.toThrow(
    /timed out/,
  );
  for (const status of [401, 429, 503]) {
    const failed = createWebResearchClient(
      async () => new Response("untrusted upstream error", { status }),
    );
    await expect(failed.search("Question", signal())).rejects.toThrow(
      status === 429 ? /rate limited/ : new RegExp(String(status)),
    );
  }
  const oversized = createWebResearchClient(
    async () => new Response("x".repeat(1_048_577)),
  );
  await expect(oversized.search("Question", signal())).rejects.toThrow(
    /too large/,
  );
});
it("searches and fetches before models without function support, retaining citations and event ordering", async () => {
  let outbound: RunRequest | undefined;
  const client = createWebResearchClient(
    async (url) =>
      new Response(
        String(url).includes("duckduckgo")
          ? html
          : "Title: Source page\nMarkdown Content:\nUseful evidence.",
      ),
  );
  const provider = withWebResearch(
    fakeProvider((value) => {
      outbound = value;
    }),
    {
      client,
      text: "Question",
      search: true,
      fetchPages: true,
      maxContextCharacters: 2500,
      createId,
    },
  );
  const events = await collect(provider);
  expect(
    events
      .filter((event) => event.type === "ToolCall")
      .map((event) => event.name),
  ).toEqual(["web_search", "web_fetch", "web_fetch"]);
  expect(
    events.filter((event) => event.type === "Source").map((event) => event.url),
  ).toEqual(["https://docs.expo.dev/", "https://example.com/article"]);
  expect(events.filter((event) => event.type === "RunStarted")).toHaveLength(1);
  expect(outbound?.context[1]?.value).toMatch(/untrusted website content/i);
  expect(outbound?.context[1]?.value).toContain("Useful evidence");
  expect(String(outbound?.context[1]?.value).length).toBeLessThanOrEqual(2500);
  expect(outbound?.context.at(-1)).toEqual(request.context.at(-1));
  expect(events.at(-1)?.type).toBe("RunCompleted");
});
it("leaves offline chat untouched and performs no web request when both switches are off", async () => {
  const provider = fakeProvider();
  const wrapped = withWebResearch(provider, {
    client: createWebResearchClient(async () => {
      throw new Error("Must not fetch");
    }),
    text: "Question",
    search: false,
    fetchPages: false,
    createId,
  });
  expect(wrapped).toBe(provider);
  await collect(wrapped);
});
it("fetch-only requires a link and preserves actionable errors", async () => {
  let started = false;
  const wrapped = withWebResearch(
    fakeProvider(() => {
      started = true;
    }),
    {
      client: createWebResearchClient(async () => new Response("")),
      text: "Question",
      search: false,
      fetchPages: true,
      createId,
    },
  );
  const events = await collect(wrapped);
  const failed = events.at(-1);
  expect(failed?.type).toBe("RunFailed");
  if (failed?.type === "RunFailed") {
    expect(toRecoverableChatError(failed.error).message).toContain(
      "Paste a public link",
    );
  }
  expect(started).toBe(false);
});
it("cancels research before generation and closes the pending tool result", async () => {
  let started = false;
  const controller = new AbortController();
  const client = createWebResearchClient(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
        controller.abort();
      }),
  );
  const events = await collect(
    withWebResearch(
      fakeProvider(() => {
        started = true;
      }),
      { client, text: "Question", search: true, fetchPages: false, createId },
    ),
    controller.signal,
  );
  expect(events.at(-1)?.type).toBe("RunCanceled");
  expect(events.some((event) => event.type === "ToolResult")).toBe(true);
  expect(started).toBe(false);
});
it("keeps search snippets when a result page denies access", async () => {
  let outbound: RunRequest | undefined;
  const client = createWebResearchClient(async (url) =>
    String(url).includes("duckduckgo")
      ? new Response(html)
      : new Response("blocked", { status: 403 }),
  );
  const events = await collect(
    withWebResearch(
      fakeProvider((value) => {
        outbound = value;
      }),
      { client, text: "Question", search: true, fetchPages: true, createId },
    ),
  );
  expect(events.at(-1)?.type).toBe("RunCompleted");
  expect(outbound?.context[1]?.value).toContain("Official documentation");
  expect(
    events.some(
      (event) =>
        event.type === "ToolResult" &&
        JSON.stringify(event.output).includes("403"),
    ),
  ).toBe(true);
  expect(outbound?.context[1]?.value).toContain(
    "Search snippet (page not read)",
  );
  expect(outbound?.context[1]?.value).toContain(
    "Some linked pages could not be read",
  );
});

const liteHtml = `<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.expo.dev%2F&amp;rut=hash" class='result-link'>Expo documentation</a></td></tr>
<tr><td class='result-snippet'>Build one JavaScript/TypeScript project that runs <b>natively</b>.</td></tr>
<a class='result-link' href='//duckduckgo.com/y.js?ad_provider=bing'>Ad redirect</a></table>`;

it("understands the live DuckDuckGo Lite format and skips internal advertising redirects", () => {
  expect(parseSearchResults(liteHtml)).toEqual([
    {
      url: "https://docs.expo.dev/",
      title: "Expo documentation",
      text: "Build one JavaScript/TypeScript project that runs natively.",
      kind: "search-snippet",
    },
  ]);
});

it("falls back to official Lite results for challenges or changed HTML, but not empty results or rate limits", async () => {
  for (const first of [
    "<form id='challenge-form'>Verification</form>",
    "<html>Changed format</html>",
  ]) {
    const calls: string[] = [];
    const client = createWebResearchClient(async (url) => {
      calls.push(String(url));
      return new Response(
        String(url).includes("html.duckduckgo") ? first : liteHtml,
      );
    });
    expect(
      (await client.search(" Expo   offline iPhone ", signal()))[0]?.url,
    ).toBe("https://docs.expo.dev/");
    expect(calls.map((url) => new URL(url).hostname)).toEqual([
      "html.duckduckgo.com",
      "lite.duckduckgo.com",
    ]);
    expect(
      calls.every(
        (url) => new URL(url).searchParams.get("q") === "Expo offline iPhone",
      ),
    ).toBe(true);
  }
  for (const response of [
    new Response("No results found"),
    new Response("limited", { status: 429 }),
  ]) {
    let calls = 0;
    const client = createWebResearchClient(async () => {
      calls++;
      return response;
    });
    if (response.ok)
      expect(await client.search("Question", signal())).toEqual([]);
    else
      await expect(client.search("Question", signal())).rejects.toThrow(
        /rate limited/,
      );
    expect(calls).toBe(1);
  }
});

it("shares one deadline between HTML and Lite attempts", async () => {
  vi.useFakeTimers();
  try {
    const calls: string[] = [];
    const client = createWebResearchClient(async (url, init) => {
      calls.push(String(url));
      if (String(url).includes("html.duckduckgo")) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response("<form id='challenge-form'>Verification</form>");
      }
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    }, 50);
    const outcome = client
      .search("Question", signal())
      .catch((cause: Error) => cause.message);
    await vi.advanceTimersByTimeAsync(40);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toMatch(/timed out/);
  } finally {
    vi.useRealTimers();
  }
});

it("cancels a stalled response body when its deadline expires", async () => {
  let canceled = false;
  const client = createWebResearchClient(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
    10,
  );
  await expect(client.search("Question", signal())).rejects.toThrow(
    /timed out/,
  );
  expect(canceled).toBe(true);
});

function readerJson(content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    code: 200,
    data: {
      title: "Expo documentation",
      url: "https://docs.expo.dev/",
      content,
      httpStatus: 200,
      ...extra,
    },
  });
}

it("uses Reader's validated JSON URL, title and content rather than its wrapper or metadata", async () => {
  const client = createWebResearchClient(
    async () =>
      new Response(readerJson("Create amazing apps that run everywhere.")),
  );
  expect(await client.fetchPage("https://docs.expo.dev", signal())).toEqual({
    url: "https://docs.expo.dev/",
    title: "Expo documentation",
    text: "Create amazing apps that run everywhere.",
    kind: "page-excerpt",
  });
});

it("rejects HTTP-200 Reader failures and verification gates without rejecting articles about CAPTCHAs", async () => {
  for (const body of [
    readerJson("You've been blocked by network security.", {
      title: "",
      httpStatus: 403,
      warning: "Target URL returned error 403: Forbidden",
    }),
    readerJson("Cookie settings", { httpStatus: 404 }),
    readerJson("Please wait while your request is verified.", {
      title: "Just a moment...",
    }),
    readerJson("Verify you are human to continue.", { title: "Example" }),
    "Title: Just a moment...\nMarkdown Content:\nPlease enable JavaScript and cookies.",
    "{invalid-json",
    JSON.stringify({ code: 401, error: "Service denied access" }),
    "Unstructured service response",
  ]) {
    const client = createWebResearchClient(async () => new Response(body));
    await expect(
      client.fetchPage("https://example.com", signal()),
    ).rejects.toThrow(/could not be read|unreadable/);
  }
  const article = createWebResearchClient(
    async () =>
      new Response(
        readerJson(
          "CAPTCHAs help websites distinguish automated traffic. This article explains accessibility issues.",
        ),
      ),
  );
  expect(
    (await article.fetchPage("https://example.com", signal())).text,
  ).toContain("accessibility");
});

it("preserves balanced URL punctuation and skips unsupported links without losing public links", () => {
  expect(
    linksInMessage(
      "Read (https://en.wikipedia.org/wiki/Function_(mathematics)). Then `https://docs.expo.dev/`. Ignore http://localhost:8080 and https://user:secret@example.com.",
    ),
  ).toEqual([
    "https://en.wikipedia.org/wiki/Function_(mathematics)",
    "https://docs.expo.dev/",
  ]);
});

it("keeps the successful direct page when either of two linked pages is blocked", async () => {
  for (const blockedFirst of [true, false]) {
    let outbound: RunRequest | undefined;
    const urls = blockedFirst
      ? ["https://example.com/blocked", "https://docs.expo.dev/"]
      : ["https://docs.expo.dev/", "https://example.com/blocked"];
    const calls: string[] = [];
    const client = createWebResearchClient(async (url) => {
      calls.push(String(url));
      return String(url).includes("blocked")
        ? new Response("blocked", { status: 403 })
        : new Response(readerJson("Genuine successful page evidence."));
    });
    const events = await collect(
      withWebResearch(
        fakeProvider((value) => {
          outbound = value;
        }),
        {
          client,
          text: `Compare ${urls.join(" and ")}`,
          search: false,
          fetchPages: true,
          createId,
        },
      ),
    );
    expect(calls).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("RunCompleted");
    expect(
      events
        .filter((event) => event.type === "Source")
        .map((event) => event.url),
    ).toEqual(["https://docs.expo.dev/"]);
    expect(outbound?.context[1]?.value).toContain(
      "Genuine successful page evidence.",
    );
    expect(outbound?.context[1]?.value).toContain(
      "Some linked pages could not be read",
    );
    expect(outbound?.context[1]?.value).not.toContain(
      "URL: https://example.com/blocked",
    );
  }
});

it("reads explicit links despite a failed search and never sends private links to the service", async () => {
  let outbound: RunRequest | undefined;
  const calls: string[] = [];
  const client = createWebResearchClient(async (url) => {
    calls.push(String(url));
    return String(url).includes("duckduckgo")
      ? new Response("limited", { status: 429 })
      : new Response(readerJson("Actual public documentation."));
  });
  const events = await collect(
    withWebResearch(
      fakeProvider((value) => {
        outbound = value;
      }),
      {
        client,
        text: "Read http://localhost:8080 and https://docs.expo.dev/",
        search: true,
        fetchPages: true,
        createId,
      },
    ),
  );
  expect(calls).toHaveLength(2);
  expect(calls.filter((url) => url.startsWith("https://r.jina.ai/"))).toEqual([
    "https://r.jina.ai/https://docs.expo.dev/",
  ]);
  expect(events.at(-1)?.type).toBe("RunCompleted");
  expect(outbound?.context[1]?.value).toContain("Search unavailable");
  expect(outbound?.context[1]?.value).toContain(
    "Unsupported links were not read",
  );
  expect(outbound?.context[1]?.value).toContain("Actual public documentation.");
});

it("stops before generation when no real evidence was retrieved", async () => {
  for (const mode of ["empty-search", "all-blocked", "title-only"] as const) {
    let started = false;
    const client = createWebResearchClient(async () =>
      mode === "empty-search"
        ? new Response("No results found")
        : mode === "title-only"
          ? new Response(
              '<a class="result__a" href="https://docs.expo.dev/">Expo docs</a>',
            )
          : new Response("blocked", { status: 403 }),
    );
    const events = await collect(
      withWebResearch(
        fakeProvider(() => {
          started = true;
        }),
        {
          client,
          text:
            mode === "all-blocked"
              ? "Read https://example.com/a and https://example.com/b"
              : "Question",
          search: mode !== "all-blocked",
          fetchPages: mode === "all-blocked",
          createId,
        },
      ),
    );
    expect(started).toBe(false);
    expect(events.at(-1)?.type).toBe("RunFailed");
    if (mode === "empty-search")
      expect(JSON.stringify(events.at(-1))).toContain(
        "No search results found",
      );
    if (mode === "title-only")
      expect(JSON.stringify(events.at(-1))).toContain(
        "without readable snippets",
      );
  }
});

it("retains an already-read source when cancellation interrupts a later page", async () => {
  const controller = new AbortController();
  let started = false;
  const client = createWebResearchClient(async (url, init) => {
    if (String(url).includes("docs.expo"))
      return new Response(readerJson("First page evidence."));
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
      controller.abort();
    });
  });
  const events = await collect(
    withWebResearch(
      fakeProvider(() => {
        started = true;
      }),
      {
        client,
        text: "https://docs.expo.dev/ https://example.com/slow",
        search: false,
        fetchPages: true,
        createId,
      },
    ),
    controller.signal,
  );
  expect(
    events.filter((event) => event.type === "Source").map((event) => event.url),
  ).toEqual(["https://docs.expo.dev/"]);
  expect(events.at(-1)?.type).toBe("RunCanceled");
  expect(events.filter((event) => event.type === "ToolCall")).toHaveLength(2);
  expect(events.filter((event) => event.type === "ToolResult")).toHaveLength(2);
  expect(started).toBe(false);
});

it("fits actual evidence and complete source URLs into small context allowances or reports a usable limit", async () => {
  for (const maximum of [500, 200]) {
    let outbound: RunRequest | undefined;
    const client = createWebResearchClient(
      async () =>
        new Response(readerJson("Important page evidence. ".repeat(1000))),
    );
    const events = await collect(
      withWebResearch(
        fakeProvider((value) => {
          outbound = value;
        }),
        {
          client,
          text: "https://docs.expo.dev/",
          search: false,
          fetchPages: true,
          maxContextCharacters: maximum,
          createId,
        },
      ),
    );
    if (maximum === 500) {
      const material = String(outbound?.context[1]?.value);
      expect(material.length).toBeLessThanOrEqual(maximum);
      expect(material).toContain("URL: https://docs.expo.dev/");
      expect(material).toContain("Important page evidence.");
      expect(material).toContain("Page excerpt");
      expect(events.at(-1)?.type).toBe("RunCompleted");
    } else {
      expect(outbound).toBeUndefined();
      expect(JSON.stringify(events.at(-1))).toContain(
        "context allowance is too small",
      );
    }
  }
});
