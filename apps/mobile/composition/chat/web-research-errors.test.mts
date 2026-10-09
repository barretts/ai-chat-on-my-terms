import { expect, it } from "vitest";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunRequest } from "@locallab/contracts/run-events";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { registerDiagnosticSecret } from "../../features/diagnostics/sanitization";
import { createBraveResearchClient } from "./brave-web-search";
import { createWebResearchClient, withWebResearch } from "./web-research";

const signal = () => new AbortController().signal;
const key = "web-errors-fixture-key-not-real";
const sentinel = "COMPLETE-WEB-FAILURE-END";
const body = JSON.stringify({
  failure: { kind: "plan", retryAfter: 12 },
  details: "a".repeat(12_000),
  echo: key,
  sentinel,
});
const headers = { "content-type": "application/problem+json" };
const ref = "sec_00000000-0000-4000-8000-000000000001" as SecretRef;
const secrets: SecretStore = {
  put: async () => {
    throw new Error("No writes in fixture");
  },
  remove: async () => {},
  resolveHeaders: async () => ({ "x-subscription-token": key }),
};

it("keeps complete public HTTP response JSON with no message field and redacts known secrets", async () => {
  registerDiagnosticSecret(key);
  const client = createWebResearchClient(
    async () =>
      new Response(body, {
        status: 429,
        statusText: "Too Many Requests",
        headers,
      }),
  );
  const failure = await client
    .search("Question", signal())
    .catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(Error);
  const text = (failure as Error).message;
  expect(text).toContain("HTTP 429 Too Many Requests");
  expect(text).toContain("application/problem+json");
  expect(text).toContain('"retryAfter":12');
  expect(text).toContain("a".repeat(12_000));
  expect(text).toContain(sentinel);
  expect(text).not.toContain(key);
});

it("keeps both failed public search formats and a full unreadable page-reader payload", async () => {
  const client = createWebResearchClient(
    async (url) =>
      new Response(
        JSON.stringify({
          failure: String(url).includes("lite.")
            ? "fallback sentinel"
            : "primary sentinel",
        }),
        { status: 503, headers },
      ),
  );
  await expect(client.search("Question", signal())).rejects.toThrow(
    /primary sentinel[\s\S]*fallback sentinel/,
  );
  const page = createWebResearchClient(
    async () => new Response(body, { headers }),
  );
  const failure = await page
    .fetchPage("https://example.com/article", signal())
    .catch((cause: unknown) => cause);
  expect((failure as Error).message).toContain(sentinel);
  expect((failure as Error).message).not.toContain(key);
});

it("keeps Brave HTTP and malformed-success failures and registers a resolved key before any error echo", async () => {
  for (const status of [200, 403, 429, 503]) {
    const client = createBraveResearchClient({
      publicClient: createWebResearchClient(async () => {
        throw new Error("No public fallback");
      }),
      secrets,
      credentialRef: ref,
      fetcher: async () => new Response(body, { status, headers }),
    });
    const failure = await client
      .search("Question", signal())
      .catch((cause: unknown) => cause);
    const text = (failure as Error).message;
    expect(text).toContain(sentinel);
    expect(text).toContain("a".repeat(12_000));
    expect(text).not.toContain(key);
    if (status !== 200) expect(text).toContain(`HTTP ${status}`);
  }
});

it("preserves native secure-store and transport causes instead of replacing them with generic research errors", async () => {
  const publicClient = createWebResearchClient(async () => {
    throw { failure: { reason: "connection refused sentinel" } };
  });
  await expect(
    publicClient.fetchPage("https://example.com/article", signal()),
  ).rejects.toThrow(/connection refused sentinel/);
  const brave = createBraveResearchClient({
    publicClient,
    secrets: {
      ...secrets,
      resolveHeaders: async () => {
        throw { failure: { reason: "keychain unavailable sentinel" } };
      },
    },
    credentialRef: ref,
    fetcher: async () => {
      throw new Error("Must not request");
    },
  });
  await expect(brave.search("Question", signal())).rejects.toThrow(
    /keychain unavailable sentinel/,
  );
});

it("retains received body text when a successful response stream breaks before completion", async () => {
  let reads = 0;
  const client = createWebResearchClient(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (reads++ === 0)
              controller.enqueue(
                new TextEncoder().encode(`Partial response ${sentinel} ${key}`),
              );
            else controller.error(new Error("Stream socket failed sentinel"));
          },
        }),
      ),
  );
  const failure = await client
    .fetchPage("https://example.com/article", signal())
    .catch((cause: unknown) => cause);
  expect((failure as Error).message).toContain("could not be read completely");
  expect((failure as Error).message).toContain(sentinel);
  expect((failure as Error).message).toContain("Stream socket failed sentinel");
  expect((failure as Error).message).not.toContain(key);
});

it("redacts complete failure details before wire tool results and failed runs can enter saved chat history", async () => {
  registerDiagnosticSecret(key);
  const provider: ProviderPort = {
    listModels: async () => ({ ok: true, value: [] }),
    getCapabilities: async () => ({ ok: true, value: {} }),
    async *startRun() {
      throw new Error("No model request on failed research");
    },
  };
  const request: RunRequest = {
    runId: "00000000-0000-7000-8000-000000000001",
    conversationId: "00000000-0000-7000-8000-000000000002",
    messageId: "00000000-0000-7000-8000-000000000003",
    providerConnectionId: "00000000-0000-7000-8000-000000000004",
    modelId: "fixture",
    context: [],
    parameters: {},
    permittedTools: [],
    attachmentRefs: [],
    reasoning: false,
    json: false,
  };
  let id = 5;
  const wrapped = withWebResearch(provider, {
    client: createWebResearchClient(
      async () => new Response(body, { status: 429, headers }),
    ),
    text: "Question",
    search: true,
    fetchPages: false,
    createId: () => `00000000-0000-7000-8000-${String(id++).padStart(12, "0")}`,
  });
  const events = [];
  for await (const event of wrapped.startRun(request, signal()))
    events.push(event);
  const wire = JSON.stringify(events);
  expect(wire).toContain(sentinel);
  expect(wire).toContain("a".repeat(12_000));
  expect(wire).not.toContain(key);
  expect(events.filter((event) => event.type === "ToolResult")).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("RunFailed");
});
