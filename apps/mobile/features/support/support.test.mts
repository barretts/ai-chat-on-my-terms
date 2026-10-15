import { describe, expect, it } from "vitest";
import { createSupportClient } from "./client";
import { buildRedactedDiagnostics } from "./redacted-diagnostics";
import type { SecureTokenPort } from "../account/client";

function tokenDouble(value: string | null): SecureTokenPort {
  return {
    async get() {
      return value;
    },
    async set() {},
    async clear() {},
  };
}

function fetchDouble(
  routes: Record<string, { status: number; body: unknown }>,
  log: { path: string; method: string; body: unknown }[],
) {
  return (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    log.push({
      path: parsed.pathname + parsed.search,
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const res = routes[parsed.pathname] ?? { status: 404, body: { code: "not-found" } };
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) satisfies typeof fetch;
}

describe("support client", () => {
  it("creates requests with the bearer token and typed fields only", async () => {
    const log: { path: string; method: string; body: unknown }[] = [];
    const client = createSupportClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble("session-1"),
      fetchImpl: fetchDouble(
        { "/support/requests": { status: 200, body: { id: "r1" } } },
        log,
      ),
    });
    const id = await client.createRequest({
      kind: "feature-request",
      title: "Widgets",
      body: "please add widgets",
    });
    expect(id).toBe("r1");
    expect(log[0]?.method).toBe("POST");
    expect(log[0]?.body).toEqual({
      kind: "feature-request",
      title: "Widgets",
      body: "please add widgets",
    });
  });

  it("votes, comments, read and attachments hit their endpoints", async () => {
    const log: { path: string; method: string; body: unknown }[] = [];
    const client = createSupportClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble("t"),
      fetchImpl: fetchDouble(
        {
          "/support/requests/r1/vote": {
            status: 200,
            body: { votes: 3, myVote: true },
          },
          "/support/requests/r1/comments": {
            status: 200,
            body: { id: "c1" },
          },
          "/support/requests/r1/read": { status: 200, body: { read: true } },
          "/support/requests/r1/attachments": {
            status: 200,
            body: { id: "a1" },
          },
        },
        log,
      ),
    });
    await client.vote("r1", true);
    await client.comment("r1", { body: "me too", parentId: "c0" });
    await client.markRead("r1");
    const attachmentId = await client.addAttachment("r1", {
      name: "shot.png",
      contentType: "image/png",
      dataBase64: "cG5n",
    });
    expect(attachmentId).toBe("a1");
    expect(log.map((entry) => entry.path)).toEqual([
      "/support/requests/r1/vote",
      "/support/requests/r1/comments",
      "/support/requests/r1/read",
      "/support/requests/r1/attachments",
    ]);
    expect(log[1]?.body).toEqual({ body: "me too", parentId: "c0" });
  });

  it("checks versions and deletes the account", async () => {
    const log: { path: string; method: string; body: unknown }[] = [];
    const client = createSupportClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble("t"),
      fetchImpl: fetchDouble(
        {
          "/support/version": {
            status: 200,
            body: { latest: "1.3.0", upToDate: false },
          },
          "/support/account": { status: 200, body: { deleted: true } },
        },
        log,
      ),
    });
    const check = await client.versionCheck("1.2.0");
    expect(check.latest).toBe("1.3.0");
    expect(log[0]?.path).toBe("/support/version?app=1.2.0");
    await client.deleteAccount();
    expect(log[1]?.method).toBe("DELETE");
  });
});

describe("redacted diagnostics", () => {
  it("emits only fixed count/version fields", () => {
    const text = buildRedactedDiagnostics({
      appVersion: "1.3.0",
      platform: "ios",
      modelCount: 4,
      conversationCount: 12,
      lastErrorCode: "model-load-failed",
      memoryFreeMb: 210.9,
    });
    expect(text).toContain("app-version: 1.3.0");
    expect(text).toContain("models-installed: 4");
    expect(text).toContain("conversation-count: 12");
    expect(text).toContain("free-memory-mb: 210");
  });

  it("refuses to smuggle free text through untrusted fields", () => {
    const text = buildRedactedDiagnostics({
      appVersion: "1.3.0 <script> secret chat text here",
      platform: "the user said hello my friend",
      modelCount: -5,
      conversationCount: 3,
      lastErrorCode: "ERROR during chat: my private prompt",
      memoryFreeMb: null,
    });
    expect(text).not.toContain("secret");
    expect(text).not.toContain("private");
    expect(text).not.toContain("hello");
    expect(text).toContain("app-version: unknown");
    expect(text).toContain("platform: unknown");
    expect(text).toContain("last-error-code: none");
    expect(text).toContain("models-installed: 0");
  });
});
