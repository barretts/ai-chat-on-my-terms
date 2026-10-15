import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import test from "node:test";
import { memoryAuthStore } from "../auth/index.js";
import { memoryCatalogStore, registerCatalogRoutes } from "./index.js";
import type { ThemeV1 } from "@locallab/themes-schema";

const TOKEN = "catalog-token";
const ADMIN_TOKEN = "admin-token";

function themeDoc(id: string, name = "Community Rose"): ThemeV1 {
  return {
    version: 1,
    id,
    name,
    kind: "custom",
    scheme: "dark",
    palette: {
      background: "#101014",
      surface: "#1b1b22",
      primary: "#d1699f",
      text: "#f2eef0",
    },
    controls: {
      fontScale: 1.1,
      bubbleStyle: "rounded",
      gradient: null,
      backgroundDim: 0.2,
      avatarSize: "medium",
      avatarPlacement: "leading",
      fontChoice: "system",
    },
  };
}

function build(adminIds: string[] = ["admin-user"]) {
  const app = Fastify();
  const auth = memoryAuthStore();
  const store = memoryCatalogStore();
  registerCatalogRoutes(app, {
    store,
    auth,
    ...(adminIds.length > 0
      ? { isAdmin: async (userId: string) => adminIds.includes(userId) }
      : {}),
    now: () => new Date("2026-05-01T00:00:00.000Z"),
  });
  const session = async (userId: string, token: string) => {
    await auth.insertSession({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  };
  return { app, store, session };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("publish then public download round-trips the theme", async () => {
  const { app, session } = build();
  await session("creator", TOKEN);
  const published = await app.inject({
    method: "POST",
    url: "/catalog/themes",
    headers: bearer(TOKEN),
    payload: { slug: "community-rose", doc: themeDoc("theme-rose") },
  });
  assert.equal(published.statusCode, 200);

  const listed = await app.inject({ method: "GET", url: "/catalog/themes" });
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].slug, "community-rose");

  // Public read (no auth header) by slug works.
  const downloaded = await app.inject({
    method: "GET",
    url: "/catalog/themes/community-rose",
  });
  assert.equal(downloaded.statusCode, 200);
  assert.deepEqual(downloaded.json().doc, themeDoc("theme-rose"));
});

test("malformed remote themes are rejected on publish", async () => {
  const { app, session } = build();
  await session("evil", TOKEN);
  const smuggled = {
    ...themeDoc("theme-x"),
    // smuggled chat/script payload: strict schema refuses it
    messages: [{ role: "user", content: "my private chat text" }],
  };
  const res = await app.inject({
    method: "POST",
    url: "/catalog/themes",
    headers: bearer(TOKEN),
    payload: { slug: "smuggled-theme", doc: smuggled },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "invalid-theme");

  const broken = await app.inject({
    method: "POST",
    url: "/catalog/themes",
    headers: bearer(TOKEN),
    payload: { slug: "broken", doc: { version: 7, name: 3 } },
  });
  assert.equal(broken.statusCode, 400);
});

test("revisions are versioned and author-only", async () => {
  const { app, session } = build();
  await session("creator", TOKEN);
  const published = await app.inject({
    method: "POST",
    url: "/catalog/themes",
    headers: bearer(TOKEN),
    payload: { slug: "rev-theme", doc: themeDoc("theme-a") },
  });
  const id = published.json().slug;
  void id;
  const listed = await app.inject({ method: "GET", url: "/catalog/themes" });
  const themeId = listed.json().items[0].id;

  const bump = await app.inject({
    method: "POST",
    url: `/catalog/themes/${themeId}/revisions`,
    headers: bearer(TOKEN),
    payload: { doc: themeDoc("theme-a", "Community Rose v2") },
  });
  assert.equal(bump.statusCode, 200);
  assert.equal(bump.json().revision, 2);

  const hist = await app.inject({
    method: "GET",
    url: `/catalog/themes/${themeId}/revisions`,
  });
  assert.equal(hist.json().revisions.length, 2);

  await session("stranger", ADMIN_TOKEN);
  const strangerBump = await app.inject({
    method: "POST",
    url: `/catalog/themes/${themeId}/revisions`,
    headers: bearer(ADMIN_TOKEN),
    payload: { doc: themeDoc("theme-a", "Hijacked") },
  });
  assert.equal(strangerBump.statusCode, 403);
  assert.equal(strangerBump.json().code, "not-author");
});

test("publish requires a session", async () => {
  const { app } = build();
  const anon = await app.inject({
    method: "POST",
    url: "/catalog/themes",
    payload: { slug: "anon-theme", doc: themeDoc("theme-anon") },
  });
  assert.equal(anon.statusCode, 401);
});

test("voice catalog is public read, admin write, and secret-free", async () => {
  const { app, session } = build(["admin-user"]);
  await session("admin-user", ADMIN_TOKEN);
  await session("regular", TOKEN);

  const ok = await app.inject({
    method: "POST",
    url: "/catalog/voices",
    headers: bearer(ADMIN_TOKEN),
    payload: {
      slug: "bright-voice",
      name: "Bright Voice",
      vendor: "Acme TTS",
      modelLabel: "acme-tts-v2",
      languages: ["en", "de"],
    },
  });
  assert.equal(ok.statusCode, 200);

  const forbidden = await app.inject({
    method: "POST",
    url: "/catalog/voices",
    headers: bearer(ADMIN_TOKEN),
    payload: {
      slug: "sneaky-voice",
      name: "Sneaky",
      vendor: "Acme",
      modelLabel: "x",
      languages: [],
      apiKey: "sk-live-should-never-be-here",
    },
  });
  assert.equal(forbidden.statusCode, 400);
  assert.equal(forbidden.json().code, "invalid-metadata");

  const notAdmin = await app.inject({
    method: "POST",
    url: "/catalog/voices",
    headers: bearer(TOKEN),
    payload: {
      slug: "user-voice",
      name: "U",
      vendor: "V",
      modelLabel: "m",
      languages: [],
    },
  });
  assert.equal(notAdmin.statusCode, 403);

  const listed = await app.inject({ method: "GET", url: "/catalog/voices" });
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].slug, "bright-voice");
});

test("catalog payloads never carry chat text", async () => {
  const { app, session } = build();
  await session("creator", TOKEN);
  await app.inject({
    method: "POST",
    url: "/catalog/themes",
    headers: bearer(TOKEN),
    payload: { slug: "clean-theme", doc: themeDoc("theme-clean") },
  });
  const [themes, detail] = await Promise.all([
    app.inject({ method: "GET", url: "/catalog/themes" }),
    app.inject({ method: "GET", url: "/catalog/themes/clean-theme" }),
  ]);
  for (const res of [themes, detail]) {
    const keys = JSON.stringify(res.json()).toLowerCase();
    // schema-only payload: no message/conversation/prompt fields exist
    for (const banned of ["message", "conversation", "prompt", "chattext"])
      assert.ok(!keys.includes(`"${banned}"`), keys);
  }
});
