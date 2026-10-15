/** Encrypted backup object storage (DA-03): ciphertext-only upload and
 * download. The server never sees passphrases and never decrypts. */
import type { FastifyInstance } from "fastify";

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
  isPro(): Promise<boolean>;
}

export function registerBackupRoutes(
  app: FastifyInstance,
  store: BackupObjectStore = memoryBackupStore(),
  gate?: ProGate,
): void {
  const allowed = async (): Promise<boolean> =>
    gate === undefined || (await gate.isPro());
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => {
      done(null, payload);
    },
  );
  app.put("/backup/objects/:id", async (request, reply) => {
    if (!(await allowed()))
      return reply.code(402).send({ code: "pro-required" });
    const { id } = request.params as { id: string };
    if (!OBJECT_ID.test(id))
      return reply.code(400).send({ code: "malformed-object-id" });
    const body = request.body;
    if (body === undefined || body === null || typeof body !== "object")
      return reply.code(400).send({ code: "missing-body" });
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer>)
      chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0)
      return reply.code(400).send({ code: "empty-object" });
    if (bytes.length > MAX_BYTES)
      return reply.code(413).send({ code: "object-too-large" });
    await store.put(id, new Uint8Array(bytes));
    return reply.code(200).send({ id, bytes: bytes.length });
  });
  app.get("/backup/objects/:id", async (request, reply) => {
    if (!(await allowed()))
      return reply.code(402).send({ code: "pro-required" });
    const { id } = request.params as { id: string };
    if (!OBJECT_ID.test(id))
      return reply.code(400).send({ code: "malformed-object-id" });
    const found = await store.get(id);
    if (found === null) return reply.code(404).send({ code: "no-such-object" });
    return reply
      .header("content-type", "application/octet-stream")
      .send(Buffer.from(found));
  });
  app.delete("/backup/objects/:id", async (request, reply) => {
    if (!(await allowed()))
      return reply.code(402).send({ code: "pro-required" });
    const { id } = request.params as { id: string };
    if (!OBJECT_ID.test(id))
      return reply.code(400).send({ code: "malformed-object-id" });
    const removed = await store.delete(id);
    return reply.code(removed ? 200 : 404).send({ removed });
  });
}
