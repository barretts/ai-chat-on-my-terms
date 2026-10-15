import { describe, expect, it } from "vitest";
import { CatalogApiError, createCommunityClient } from "./client";
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
  log: { path: string; init: RequestInit }[],
) {
  return (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    log.push({ path, init });
    const res = routes[path] ?? { status: 404, body: { code: "not-found" } };
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) satisfies typeof fetch;
}

describe("community client", () => {
  it("lists the public catalog without a token", async () => {
    const log: { path: string; init: RequestInit }[] = [];
    const client = createCommunityClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble(null),
      fetchImpl: fetchDouble(
        {
          "/catalog/themes": {
            status: 200,
            body: {
              items: [
                {
                  id: "t1",
                  slug: "rose",
                  authorId: "u1",
                  updatedAt: "2026-05-01T00:00:00.000Z",
                  revisions: 2,
                },
              ],
            },
          },
        },
        log,
      ),
    });
    const items = await client.listThemes();
    expect(items[0]?.slug).toBe("rose");
    expect((log[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(log[0]?.init.headers).not.toHaveProperty("authorization");
  });

  it("downloads a theme by slug", async () => {
    const client = createCommunityClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble(null),
      fetchImpl: fetchDouble(
        {
          "/catalog/themes/rose": {
            status: 200,
            body: { id: "t1", slug: "rose", revision: 2, doc: { version: 1 } },
          },
        },
        [],
      ),
    });
    const detail = await client.getTheme("rose");
    expect(detail.revision).toBe(2);
  });

  it("publishes with the account bearer token", async () => {
    const log: { path: string; init: RequestInit }[] = [];
    const client = createCommunityClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble("session-xyz"),
      fetchImpl: fetchDouble(
        {
          "/catalog/themes": {
            status: 200,
            body: { slug: "my-theme", revision: 1 },
          },
        },
        log,
      ),
    });
    const res = await client.publishTheme("my-theme", { version: 1, id: "x" });
    expect(res.revision).toBe(1);
    const headers = log[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer session-xyz");
    const body = JSON.parse(log[0]?.init.body as string);
    expect(body.slug).toBe("my-theme");
    expect(body.doc.id).toBe("x");
  });

  it("rejects malformed themes with the server code", async () => {
    const client = createCommunityClient({
      baseUrl: "https://svc.test",
      tokens: tokenDouble("t"),
      fetchImpl: fetchDouble(
        {
          "/catalog/themes": {
            status: 400,
            body: { code: "invalid-theme", reason: "unrecognized keys" },
          },
        },
        [],
      ),
    });
    await expect(client.publishTheme("bad", { hacked: true })).rejects.toThrow(
      CatalogApiError,
    );
    await expect(client.publishTheme("bad", { hacked: true })).rejects.toMatchObject(
      { status: 400, code: "invalid-theme" },
    );
  });
});
