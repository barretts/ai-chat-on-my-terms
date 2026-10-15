/** Support board + release metadata (AC-05/AC-06/AC-07): feature
 * requests and tickets with votes, comment threads (replies), unread
 * markers, explicit attachment uploads, changelog/update checks and
 * support-metadata account deletion. Nothing here ever reads chat data:
 * every payload is what the user explicitly typed or attached. */

import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuthStore } from "../auth/index.js";

const MAX_TITLE = 120;
const MAX_BODY = 4000;
const MAX_COMMENT = 2000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "application/pdf",
  "text/plain",
];

export interface SupportRequest {
  id: string;
  kind: "feature-request" | "support-ticket";
  title: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupportComment {
  id: string;
  requestId: string;
  authorId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
}

export interface SupportAttachment {
  id: string;
  requestId: string;
  uploaderId: string;
  name: string;
  contentType: string;
  dataBase64: string;
  createdAt: string;
}

export interface ChangelogEntry {
  version: string;
  notes: string;
  releasedAt: string;
}

export interface SupportStore {
  insertRequest(request: SupportRequest): Promise<void>;
  findRequest(id: string): Promise<SupportRequest | null>;
  listRequests(): Promise<SupportRequest[]>;
  insertComment(comment: SupportComment): Promise<void>;
  commentsOf(requestId: string): Promise<SupportComment[]>;
  setVote(requestId: string, userId: string, up: boolean): Promise<void>;
  votesOf(requestId: string): Promise<string[]>;
  markRead(userId: string, requestId: string, at: string): Promise<void>;
  lastReadAt(userId: string, requestId: string): Promise<string | null>;
  insertAttachment(attachment: SupportAttachment): Promise<void>;
  findAttachment(id: string): Promise<SupportAttachment | null>;
  attachmentsOf(requestId: string): Promise<SupportAttachment[]>;
  deleteAllFor(userId: string): Promise<void>;
  listChangelog(): Promise<ChangelogEntry[]>;
}

export function memorySupportStore(
  seed: { changelog?: ChangelogEntry[] } = {},
): SupportStore {
  const requests: SupportRequest[] = [];
  const comments: SupportComment[] = [];
  const votes = new Map<string, Set<string>>();
  const reads = new Map<string, string>();
  const attachments: SupportAttachment[] = [];
  const changelog = [...(seed.changelog ?? [])];
  const readKey = (userId: string, requestId: string) =>
    `${userId}\u0000${requestId}`;
  return {
    async insertRequest(request) {
      requests.push(request);
    },
    async findRequest(id) {
      return requests.find((item) => item.id === id) ?? null;
    },
    async listRequests() {
      return [...requests];
    },
    async insertComment(comment) {
      comments.push(comment);
    },
    async commentsOf(requestId) {
      return comments.filter((item) => item.requestId === requestId);
    },
    async setVote(requestId, userId, up) {
      let current = votes.get(requestId);
      if (current === undefined) {
        current = new Set();
        votes.set(requestId, current);
      }
      if (up) current.add(userId);
      else current.delete(userId);
    },
    async votesOf(requestId) {
      return [...(votes.get(requestId) ?? new Set())];
    },
    async markRead(userId, requestId, at) {
      reads.set(readKey(userId, requestId), at);
    },
    async lastReadAt(userId, requestId) {
      return reads.get(readKey(userId, requestId)) ?? null;
    },
    async insertAttachment(attachment) {
      attachments.push(attachment);
    },
    async findAttachment(id) {
      return attachments.find((item) => item.id === id) ?? null;
    },
    async attachmentsOf(requestId) {
      return attachments.filter((item) => item.requestId === requestId);
    },
    async deleteAllFor(userId) {
      for (let i = requests.length - 1; i >= 0; i--)
        if (requests[i]?.authorId === userId) requests.splice(i, 1);
      for (let i = comments.length - 1; i >= 0; i--)
        if (comments[i]?.authorId === userId) comments.splice(i, 1);
      for (let i = attachments.length - 1; i >= 0; i--)
        if (attachments[i]?.uploaderId === userId) attachments.splice(i, 1);
      for (const voters of votes.values()) voters.delete(userId);
      for (const key of [...reads.keys()])
        if (key.startsWith(`${userId}\u0000`)) reads.delete(key);
    },
    async listChangelog() {
      return [...changelog];
    },
  };
}

export interface RegisterSupportOptions {
  store: SupportStore;
  auth: AuthStore;
  now?: () => Date;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function registerSupportRoutes(
  app: FastifyInstance,
  options: RegisterSupportOptions,
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

  /* ---------- requests, votes, comments, unread (AC-05) ---------- */

  app.get("/support/requests", async (request) => {
    const userId = await sessionUserId(request.headers);
    const requests = await options.store.listRequests();
    const items = [];
    for (const item of requests) {
      const voters = await options.store.votesOf(item.id);
      const comments = await options.store.commentsOf(item.id);
      const lastRead =
        userId === null
          ? null
          : await options.store.lastReadAt(userId, item.id);
      const unreadReplies =
        userId === null || lastRead === null
          ? comments.length
          : comments.filter((comment) => comment.createdAt > lastRead).length;
      items.push({
        ...item,
        votes: voters.length,
        ...(userId === null
          ? {}
          : { myVote: voters.includes(userId), unreadReplies }),
      });
    }
    return { items };
  });

  // Explicit user submit only: the device client never posts without an
  // intentional tap, and bodies are bounded user text (no chat content
  // unless the user pastes it themselves).
  app.post("/support/requests", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const body = request.body as {
      kind?: unknown;
      title?: unknown;
      body?: unknown;
    };
    const kind = body.kind;
    const title = body.title;
    const text = body.body;
    if (
      kind !== "feature-request" &&
      kind !== "support-ticket"
    )
      return reply.code(400).send({ code: "bad-kind" });
    if (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE)
      return reply.code(400).send({ code: "bad-title" });
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_BODY)
      return reply.code(400).send({ code: "bad-body" });
    const at = now().toISOString();
    const id = randomUUID();
    await options.store.insertRequest({
      id,
      kind,
      title,
      body: text,
      authorId: userId,
      createdAt: at,
      updatedAt: at,
    });
    await options.store.setVote(id, userId, true);
    return reply.code(200).send({ id });
  });

  app.post("/support/requests/:id/vote", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const { id } = request.params as { id: string };
    if ((await options.store.findRequest(id)) === null)
      return reply.code(404).send({ code: "not-found" });
    const up = (request.body as { up?: unknown }).up !== false;
    await options.store.setVote(id, userId, up);
    const voters = await options.store.votesOf(id);
    return reply.code(200).send({ votes: voters.length, myVote: up });
  });

  app.get("/support/requests/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = await options.store.findRequest(id);
    if (item === null) return reply.code(404).send({ code: "not-found" });
    const comments = await options.store.commentsOf(id);
    const attachments = await options.store.attachmentsOf(id);
    return reply.code(200).send({
      request: item,
      comments,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        contentType: attachment.contentType,
        createdAt: attachment.createdAt,
      })),
    });
  });

  app.post("/support/requests/:id/comments", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const { id } = request.params as { id: string };
    if ((await options.store.findRequest(id)) === null)
      return reply.code(404).send({ code: "not-found" });
    const body = request.body as { body?: unknown; parentId?: unknown };
    if (
      typeof body.body !== "string" ||
      body.body.length === 0 ||
      body.body.length > MAX_COMMENT
    )
      return reply.code(400).send({ code: "bad-comment" });
    if (body.parentId !== undefined && body.parentId !== null) {
      const parent = (await options.store.commentsOf(id)).find(
        (comment) => comment.id === body.parentId,
      );
      if (parent === undefined)
        return reply.code(400).send({ code: "bad-parent" });
    }
    const comment: SupportComment = {
      id: randomUUID(),
      requestId: id,
      authorId: userId,
      parentId:
        typeof body.parentId === "string" ? body.parentId : null,
      body: body.body,
      createdAt: now().toISOString(),
    };
    await options.store.insertComment(comment);
    return reply.code(200).send({ id: comment.id });
  });

  // Unread indicators: the board marks a request read for this user.
  app.post("/support/requests/:id/read", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const { id } = request.params as { id: string };
    if ((await options.store.findRequest(id)) === null)
      return reply.code(404).send({ code: "not-found" });
    await options.store.markRead(userId, id, now().toISOString());
    return reply.code(200).send({ read: true });
  });

  /* ---------- attachments (AC-06): upload only on explicit submit ---------- */

  app.post("/support/requests/:id/attachments", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const { id } = request.params as { id: string };
    if ((await options.store.findRequest(id)) === null)
      return reply.code(404).send({ code: "not-found" });
    const body = request.body as {
      name?: unknown;
      contentType?: unknown;
      dataBase64?: unknown;
    };
    if (
      typeof body.name !== "string" ||
      body.name.length === 0 ||
      body.name.length > 120 ||
      typeof body.contentType !== "string" ||
      !ATTACHMENT_TYPES.includes(body.contentType) ||
      typeof body.dataBase64 !== "string"
    )
      return reply.code(400).send({ code: "invalid-attachment" });
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.dataBase64, "base64");
    } catch {
      return reply.code(400).send({ code: "invalid-attachment" });
    }
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES)
      return reply.code(400).send({ code: "invalid-attachment" });
    const attachment: SupportAttachment = {
      id: randomUUID(),
      requestId: id,
      uploaderId: userId,
      name: body.name,
      contentType: body.contentType,
      dataBase64: bytes.toString("base64"),
      createdAt: now().toISOString(),
    };
    await options.store.insertAttachment(attachment);
    return reply.code(200).send({ id: attachment.id });
  });

  app.get("/support/attachments/:id", async (request, reply) => {
    const userId = await sessionUserId(request.headers);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    const { id } = request.params as { id: string };
    const attachment = await options.store.findAttachment(id);
    if (attachment === null) return reply.code(404).send({ code: "not-found" });
    return reply.code(200).send({
      name: attachment.name,
      contentType: attachment.contentType,
      dataBase64: attachment.dataBase64,
    });
  });

  /* ---------- changelog / update checks (AC-07) ---------- */

  app.get("/support/changelog", async () => {
    return { items: await options.store.listChangelog() };
  });

  app.get("/support/version", async (request) => {
    const query = request.query as { app?: string };
    const changelog = await options.store.listChangelog();
    let latest: ChangelogEntry | null = null;
    for (const entry of changelog)
      if (latest === null || compareVersions(entry.version, latest.version) > 0)
        latest = entry;
    const installed = typeof query.app === "string" ? query.app : null;
    return {
      latest: latest?.version ?? null,
      upToDate:
        latest === null
          ? true
          : installed === null
            ? false
            : compareVersions(installed, latest.version) >= 0,
    };
  });

  /* ---------- account deletion for online metadata ---------- */

  app.delete("/support/account", async (request, reply) => {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer "))
      return reply.code(401).send({ code: "no-session" });
    const tokenHash = createHash("sha256")
      .update(header.slice(7))
      .digest("hex");
    const session = await options.auth.findSession(tokenHash);
    if (session === null) return reply.code(401).send({ code: "no-session" });
    await options.store.deleteAllFor(session.userId);
    await options.auth.deleteUser(session.userId);
    return reply.code(200).send({ deleted: true });
  });
}
