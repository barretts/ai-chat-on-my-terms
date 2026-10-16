/** Encrypted backup object storage (DA-03): ciphertext-only upload and
 * download. The server never sees passphrases and never decrypts. */
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import type { AuthStore } from "../auth/index.js";

export interface BackupObjectStore {
  put(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array | null>;
  delete(id: string): Promise<boolean>;
}

export function memoryBackupStore(): BackupObjectStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(id, bytes) {
      objects.set(id, Uint8Array.from(bytes));
    },
    async get(id) {
      const found = objects.get(id);
      return found === undefined ? null : Uint8Array.from(found);
    },
    async delete(id) {
      return objects.delete(id);
    },
  };
}

const OBJECT_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const MAX_BYTES = 512 * 1024 * 1024;

/** Server-side entitlement check; UI state is never trusted. Endpoints
 * reject Pro traffic directly when the gate says so. */
export interface ProGate {
  isPro(userId: string): Promise<boolean>;
}

export function registerBackupRoutes(
  app: FastifyInstance,
  store: BackupObjectStore = memoryBackupStore(),
  gate?: ProGate,
  auth?: Pick<AuthStore, "findSession">,
): void {
  const userIdFor = async (authorization: string | undefined): Promise<string | null> => {
    if (auth === undefined || !authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice(7);
    if (token === "") return null;
    const session = await auth.findSession(createHash("sha256").update(token).digest("hex"));
    return session?.userId ?? null;
  };
  // Existing unscoped objects are intentionally inaccessible: guessing an
  // old object ID is not evidence that an account owns it.
  const ownedKey = (userId: string, id: string) => JSON.stringify([userId, id]);
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => {
      done(null, payload);
    },
  );
  app.put("/backup/objects/:id", async (request, reply) => {
    const userId = await userIdFor(request.headers.authorization);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    if (gate === undefined || !(await gate.isPro(userId)))
      return reply.code(402).send({ code: "pro-required" });
    const { id } = request.params as { id: string };
    if (!OBJECT_ID.test(id))
      return reply.code(400).send({ code: "malformed-object-id" });
    const body = request.body;
    if (body === undefined || body === null || typeof body !== "object")
      return reply.code(400).send({ code: "missing-body" });
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of body as AsyncIterable<Buffer>) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_BYTES)
        return reply.code(413).send({ code: "object-too-large" });
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0)
      return reply.code(400).send({ code: "empty-object" });
    if (bytes.length > MAX_BYTES)
      return reply.code(413).send({ code: "object-too-large" });
    await store.put(ownedKey(userId, id), new Uint8Array(bytes));
    return reply.code(200).send({ id, bytes: bytes.length });
  });
  app.get("/backup/objects/:id", async (request, reply) => {
    const userId = await userIdFor(request.headers.authorization);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    if (gate === undefined || !(await gate.isPro(userId)))
      return reply.code(402).send({ code: "pro-required" });
    const { id } = request.params as { id: string };
    if (!OBJECT_ID.test(id))
      return reply.code(400).send({ code: "malformed-object-id" });
    const found = await store.get(ownedKey(userId, id));
    if (found === null) return reply.code(404).send({ code: "no-such-object" });
    return reply
      .header("content-type", "application/octet-stream")
      .send(Buffer.from(found));
  });
  app.delete("/backup/objects/:id", async (request, reply) => {
    const userId = await userIdFor(request.headers.authorization);
    if (userId === null) return reply.code(401).send({ code: "no-session" });
    if (gate === undefined || !(await gate.isPro(userId)))
      return reply.code(402).send({ code: "pro-required" });
    const { id } = request.params as { id: string };
    if (!OBJECT_ID.test(id))
      return reply.code(400).send({ code: "malformed-object-id" });
    const removed = await store.delete(ownedKey(userId, id));
    return reply.code(removed ? 200 : 404).send({ removed });
  });
}
