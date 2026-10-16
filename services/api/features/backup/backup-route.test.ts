import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import test from "node:test";
import {
  createEntitlements,
  memoryEntitlementStore,
} from "@locallab/entitlements";
import { memoryAuthStore, type AuthStore } from "../auth/index.js";
import {
  memoryBackupStore,
  ownedKey,
  registerBackupRoutes,
  type ProGate,
} from "./index.js";

// R026 (commit cb44ec5) made every backup object route require an account
// session and a Pro entitlement, and scoped storage keys to the owner. The
// requests below authenticate with the same session helper used by the
// passing sibling suite features/support/support-route.test.ts.
function sessionToken(auth: AuthStore, userId: string) {
  const token = `tok-${userId}`;
  return {
    token,
    install: async () => {
      await auth.insertSession({
        tokenHash: createHash("sha256").update(token).digest("hex"),
        userId,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    },
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const binary = (token: string) => ({
  "content-type": "application/octet-stream",
  ...bearer(token),
});

const proGate: ProGate = { isPro: async () => true };

const build = () => {
  const app = Fastify();
  const store = memoryBackupStore();
  const auth = memoryAuthStore();
  const alice = sessionToken(auth, "alice");
  registerBackupRoutes(app, store, proGate, auth);
  return { app, store, auth, alice };
};

const entitlementGate = (pro: boolean) => {
  const entitlements = createEntitlements({
    mode: "release",
    store: memoryEntitlementStore(),
    clock: () => new Date("2026-10-14T00:00:00.000Z"),
    receipts: { verify: async () => ({ pro }) },
  });
  return {
    entitlements,
    gate: { isPro: () => entitlements.isPro("cloudBackup") } satisfies ProGate,
  };
};

test("ciphertext objects round-trip byte-for-byte", async () => {
  const { app, alice } = build();
  await alice.install();
  const payload = Buffer.from([0x4c, 0x4c, 0x42, 0x4b, 0x50, 0x31, 0x0a, 0xff, 0x00, 0x9c]);
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/ws-2026-10-14",
    headers: binary(alice.token),
    payload,
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), { id: "ws-2026-10-14", bytes: payload.length });
  const get = await app.inject({
    method: "GET",
    url: "/backup/objects/ws-2026-10-14",
    headers: bearer(alice.token),
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["content-type"], "application/octet-stream");
  assert.deepEqual([...get.rawPayload], [...payload]);
});

test("missing objects 404 and deletion is reported", async () => {
  const { app, alice } = build();
  await alice.install();
  const missing = await app.inject({
    method: "GET",
    url: "/backup/objects/aaaaaaaa",
    headers: bearer(alice.token),
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "no-such-object");
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/aaaaaaaa",
    headers: binary(alice.token),
    payload: Buffer.from("ciphertext bytes"),
  });
  assert.equal(put.statusCode, 200);
  const removed = await app.inject({
    method: "DELETE",
    url: "/backup/objects/aaaaaaaa",
    headers: bearer(alice.token),
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().removed, true);
  const again = await app.inject({
    method: "DELETE",
    url: "/backup/objects/aaaaaaaa",
    headers: bearer(alice.token),
  });
  assert.equal(again.statusCode, 404);
});

test("malformed ids and empty objects are rejected", async () => {
  const { app, store, alice } = build();
  await alice.install();
  const badId = await app.inject({
    method: "PUT",
    url: "/backup/objects/Short",
    headers: binary(alice.token),
    payload: Buffer.from("bytes!"),
  });
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.json().code, "malformed-object-id");
  const empty = await app.inject({
    method: "PUT",
    url: "/backup/objects/valid-id-1",
    headers: binary(alice.token),
    payload: Buffer.alloc(0),
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().code, "empty-object");
  assert.equal(await store.get(ownedKey("alice", "valid-id-1")), null);
});

test("routes never interpret the payload; corrupt zips are stored as-is", async () => {
  const { app, store, alice } = build();
  await alice.install();
  const junk = Buffer.from("this is not a zip and not decryptable");
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/opaque-data",
    headers: binary(alice.token),
    payload: junk,
  });
  assert.equal(put.statusCode, 200);
  const stored = await store.get(ownedKey("alice", "opaque-data"));
  assert.deepEqual([...(stored ?? [])], [...junk]);
});

test("Pro backup endpoints reject non-Pro clients even with direct calls", async () => {
  const app = Fastify();
  const store = memoryBackupStore();
  const auth = memoryAuthStore();
  const alice = sessionToken(auth, "alice");
  const { gate } = entitlementGate(false);
  registerBackupRoutes(app, store, gate, auth);
  await alice.install();
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/gated-object",
    headers: binary(alice.token),
    payload: Buffer.from("ciphertext"),
  });
  assert.equal(put.statusCode, 402);
  assert.equal(put.json().code, "pro-required");
  const get = await app.inject({
    method: "GET",
    url: "/backup/objects/gated-object",
    headers: bearer(alice.token),
  });
  assert.equal(get.statusCode, 402);
  assert.equal(await store.get(ownedKey("alice", "gated-object")), null);
});

test("the same endpoints open once the entitlement verifies Pro", async () => {
  const app = Fastify();
  const store = memoryBackupStore();
  const auth = memoryAuthStore();
  const alice = sessionToken(auth, "alice");
  const { entitlements, gate } = entitlementGate(true);
  await entitlements.verifyPro();
  registerBackupRoutes(app, store, gate, auth);
  await alice.install();
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/open-object",
    headers: binary(alice.token),
    payload: Buffer.from("ciphertext"),
  });
  assert.equal(put.statusCode, 200);
});

test("anonymous and other-account callers cannot touch an owner's object", async () => {
  const { app, store, alice } = build();
  await alice.install();
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/owned-object",
    headers: binary(alice.token),
    payload: Buffer.from("alice ciphertext"),
  });
  assert.equal(put.statusCode, 200);

  const anon = await app.inject({ method: "GET", url: "/backup/objects/owned-object" });
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.json().code, "no-session");

  // Same displayed ID under another Pro account must not collide: account B
  // sees its own empty namespace, never alice's object.
  const appB = Fastify();
  const storeB = memoryBackupStore();
  const authB = memoryAuthStore();
  const bobB = sessionToken(authB, "bob");
  registerBackupRoutes(appB, storeB, proGate, authB);
  await bobB.install();
  const stealGet = await appB.inject({
    method: "GET",
    url: "/backup/objects/owned-object",
    headers: bearer(bobB.token),
  });
  assert.equal(stealGet.statusCode, 404);
  const stealDelete = await appB.inject({
    method: "DELETE",
    url: "/backup/objects/owned-object",
    headers: bearer(bobB.token),
  });
  assert.equal(stealDelete.statusCode, 404);
  assert.deepEqual(
    [...((await store.get(ownedKey("alice", "owned-object"))) ?? [])],
    [...Buffer.from("alice ciphertext")],
  );
});
