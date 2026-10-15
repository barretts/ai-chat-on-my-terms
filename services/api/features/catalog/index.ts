/** Community catalog (UI-02/AC-08): authenticated theme publish with
 * public read, revisions, and safe asset validation via the shared
 * themes schema (strict: unknown fields — chat payloads, scripts — are
 * rejected). Voice entries are administratively curated metadata only;
 * nothing about secret keys lives in this catalog, and catalog payloads
 * never carry chat text. */

import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseThemeImport, type ThemeV1 } from "@locallab/themes-schema";
import type { AuthStore } from "../auth/index.js";

const SLUG = /^[a-z0-9][a-z0-9-]{2,63}$/;
const FORBIDDEN_METADATA_KEY = /(key|secret|token|password|credential|apikey)/i;

export interface ThemeRevision {
  n: number;
  publishedAt: string;
  doc: ThemeV1;
}

export interface ThemeListing {
  id: string;
  slug: string;
  authorId: string;
  updatedAt: string;
  revisions: number;
}

export interface ThemeEntry extends ThemeListing {
  history: ThemeRevision[];
}

export interface VoicePack {
  id: string;
  slug: string;
  name: string;
  vendor: string;
  modelLabel: string;
  languages: string[];
}

export interface CatalogStore {
  insertTheme(entry: ThemeEntry): Promise<void>;
  findTheme(id: string): Promise<ThemeEntry | null>;
  findThemeBySlug(slug: string): Promise<ThemeEntry | null>;
  listThemes(): Promise<ThemeListing[]>;
  updateTheme(entry: ThemeEntry): Promise<void>;
  insertVoice(pack: VoicePack): Promise<void>;
  listVoices(): Promise<VoicePack[]>;
  deleteVoice(id: string): Promise<boolean>;
}

export function memoryCatalogStore(): CatalogStore {
  const themes: ThemeEntry[] = [];
  const voices: VoicePack[] = [];
  return {
    async insertTheme(entry) {
      themes.push(entry);
    },
    async findTheme(id) {
      return themes.find((item) => item.id === id) ?? null;
    },
    async findThemeBySlug(slug) {
      return themes.find((item) => item.slug === slug) ?? null;
    },
    async listThemes() {
      return themes.map((item) => ({
        id: item.id,
        slug: item.slug,
        authorId: item.authorId,
        updatedAt: item.updatedAt,
        revisions: item.history.length,
      }));
    },
    async updateTheme(entry) {
      const index = themes.findIndex((item) => item.id === entry.id);
      if (index >= 0) themes[index] = entry;
    },
    async insertVoice(pack) {
      voices.push(pack);
    },
    async listVoices() {
      return voices.map((item) => ({ ...item, languages: [...item.languages] }));
    },
    async deleteVoice(id) {
      const index = voices.findIndex((item) => item.id === id);
      if (index < 0) return false;
      voices.splice(index, 1);
      return true;
    },
  };
}

export interface RegisterCatalogOptions {
  store: CatalogStore;
  auth: AuthStore;
  isAdmin?: (userId: string) => Promise<boolean>;
  now?: () => Date;
}

function safeVoiceMetadata(value: unknown): VoicePack | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (FORBIDDEN_METADATA_KEY.test(key)) return null;
  const { slug, name, vendor, modelLabel } = record;
  const languages = record.languages;
  if (
    typeof slug !== "string" ||
    !SLUG.test(slug) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 80 ||
    typeof vendor !== "string" ||
    vendor.length === 0 ||
    vendor.length > 80 ||
    typeof modelLabel !== "string" ||
    modelLabel.length === 0 ||
    modelLabel.length > 120 ||
    !Array.isArray(languages) ||
    languages.length > 20 ||
    !languages.every((item) => typeof item === "string" && item.length <= 16)
  )
    return null;
  return {
    id: randomUUID(),
    slug,
    name,
    vendor,
    modelLabel,
    languages: languages as string[],
  };
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  options: RegisterCatalogOptions,
): void {
  const now = options.now ?? (() => new Date());

  async function sessionUserId(
    headers: { authorization?: string },
  ): Promise<string | null> {
    const header = headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return null;
    const tokenHash = createHash("sha256")
      .update(header.slice(7))
      .digest("hex");
    const session = await options.auth.findSession(tokenHash);
    return session === null ? null : session.userId;
  }

  /* ---------- themes ---------- */

  // Step 1: public read catalog.
  app.get("/catalog/themes", async () => {
    return { items: await options.store.listThemes() };
  });

  app.get("/catalog/themes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry =
      (await options.store.findTheme(id)) ??
      (await options.store.findThemeBySlug(id));
    if (entry === null) return reply.code(404).send({ code: "not-found" });
    const latest = entry.history[entry.history.length - 1];
    return reply.code(200).send({
      id: entry.id,
      slug: entry.slug,
      revision: latest?.n ?? 0,
      doc: latest?.doc ?? null,
    });
  });

  app.get("/catalog/themes/:id/revisions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await options.store.findTheme(id);
    if (entry === null) return reply.code(404).send({ code: "not-found" });
    return reply.code(200).send({
      revisions: entry.history.map((item) => ({
        n: item.n,
        publishedAt: item.publishedAt,
      })),
    });
  });

  app.post("/catalog/themes", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const body = request.body as { slug?: unknown; doc?: unknown };
    if (typeof body.slug !== "string" || !SLUG.test(body.slug))
      return reply.code(400).send({ code: "bad-slug" });
    const parsed = parseThemeImport(body.doc);
    // Safe asset validation: strict schema rejects unknown/scripted/chat
    // fields; malformed remote themes never enter the catalog.
    if (!parsed.ok)
      return reply
        .code(400)
        .send({ code: "invalid-theme", reason: parsed.reason });
    if ((await options.store.findThemeBySlug(body.slug)) !== null)
      return reply.code(409).send({ code: "slug-taken" });
    const at = now().toISOString();
    await options.store.insertTheme({
      id: randomUUID(),
      slug: body.slug,
      authorId: userId,
      updatedAt: at,
      revisions: 1,
      history: [{ n: 1, publishedAt: at, doc: parsed.theme }],
    });
    return reply.code(200).send({ slug: body.slug, revision: 1 });
  });

  app.post("/catalog/themes/:id/revisions", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const { id } = request.params as { id: string };
    const entry = await options.store.findTheme(id);
    if (entry === null) return reply.code(404).send({ code: "not-found" });
    if (entry.authorId !== userId)
      return reply.code(403).send({ code: "not-author" });
    const parsed = parseThemeImport((request.body as { doc?: unknown }).doc);
    if (!parsed.ok)
      return reply
        .code(400)
        .send({ code: "invalid-theme", reason: parsed.reason });
    const at = now().toISOString();
    const n = entry.history.length + 1;
    entry.history.push({ n, publishedAt: at, doc: parsed.theme });
    entry.revisions = n;
    entry.updatedAt = at;
    await options.store.updateTheme(entry);
    return reply.code(200).send({ revision: n });
  });

  /* ---------- voices (curated metadata; no secrets, no store keys) ---------- */

  // Step 2: public read; writes are administrator-only.
  app.get("/catalog/voices", async () => {
    return { items: await options.store.listVoices() };
  });

  app.post("/catalog/voices", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    if (
      options.isAdmin === undefined ||
      !(await options.isAdmin(userId))
    )
      return reply.code(403).send({ code: "not-admin" });
    const pack = safeVoiceMetadata(request.body);
    if (pack === null)
      return reply.code(400).send({ code: "invalid-metadata" });
    await options.store.insertVoice(pack);
    return reply.code(200).send({ id: pack.id, slug: pack.slug });
  });

  app.delete("/catalog/voices/:id", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    if (
      options.isAdmin === undefined ||
      !(await options.isAdmin(userId))
    )
      return reply.code(403).send({ code: "not-admin" });
    const { id } = request.params as { id: string };
    const removed = await options.store.deleteVoice(id);
    if (!removed) return reply.code(404).send({ code: "not-found" });
    return reply.code(200).send({ removed: true });
  });
}
