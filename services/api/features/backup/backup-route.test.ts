import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";
import {
  createEntitlements,
  memoryEntitlementStore,
} from "@locallab/entitlements";
import { memoryBackupStore, registerBackupRoutes } from "./index.js";

const build = () => {
  const app = Fastify();
  const store = memoryBackupStore();
  registerBackupRoutes(app, store);
  return { app, store };
};

test("ciphertext objects round-trip byte-for-byte", async () => {
  const { app } = build();
  const payload = Buffer.from([0x4c, 0x4c, 0x42, 0x4b, 0x50, 0x31, 0x0a, 0xff, 0x00, 0x9c]);
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/ws-2026-10-14",
    headers: { "content-type": "application/octet-stream" },
    payload,
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), { id: "ws-2026-10-14", bytes: payload.length });
  const get = await app.inject({
    method: "GET",
    url: "/backup/objects/ws-2026-10-14",
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["content-type"], "application/octet-stream");
  assert.deepEqual([...get.rawPayload], [...payload]);
});

test("missing objects 404 and deletion is reported", async () => {
  const { app } = build();
  const missing = await app.inject({
    method: "GET",
    url: "/backup/objects/aaaaaaaa",
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "no-such-object");
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/aaaaaaaa",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("ciphertext bytes"),
  });
  assert.equal(put.statusCode, 200);
  const removed = await app.inject({
    method: "DELETE",
    url: "/backup/objects/aaaaaaaa",
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().removed, true);
  const again = await app.inject({
    method: "DELETE",
    url: "/backup/objects/aaaaaaaa",
  });
  assert.equal(again.statusCode, 404);
});

test("malformed ids and empty objects are rejected", async () => {
  const { app, store } = build();
  const badId = await app.inject({
    method: "PUT",
    url: "/backup/objects/Short",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("bytes!"),
  });
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.json().code, "malformed-object-id");
  const empty = await app.inject({
    method: "PUT",
    url: "/backup/objects/valid-id-1",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.alloc(0),
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().code, "empty-object");
  assert.equal(await store.get("valid-id-1"), null);
});

test("routes never interpret the payload; corrupt zips are stored as-is", async () => {
  const { app, store } = build();
  const junk = Buffer.from("this is not a zip and not decryptable");
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/opaque-data",
    headers: { "content-type": "application/octet-stream" },
    payload: junk,
  });
  assert.equal(put.statusCode, 200);
  const stored = await store.get("opaque-data");
  assert.deepEqual([...(stored ?? [])], [...junk]);
});

test("Pro backup endpoints reject non-Pro clients even with direct calls", async () => {
  const app = Fastify();
  const store = memoryBackupStore();
  const entitlements = createEntitlements({
    mode: "release",
    store: memoryEntitlementStore(),
    clock: () => new Date("2026-10-14T00:00:00.000Z"),
    receipts: { verify: async () => ({ pro: false }) },
  });
  registerBackupRoutes(app, store, {
    isPro: () => entitlements.isPro("cloudBackup"),
  });
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/gated-object",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("ciphertext"),
  });
  assert.equal(put.statusCode, 402);
  assert.equal(put.json().code, "pro-required");
  const get = await app.inject({
    method: "GET",
    url: "/backup/objects/gated-object",
  });
  assert.equal(get.statusCode, 402);
  assert.equal(await store.get("gated-object"), null);
});

test("the same endpoints open once the entitlement verifies Pro", async () => {
  const app = Fastify();
  const store = memoryBackupStore();
  const entitlements = createEntitlements({
    mode: "release",
    store: memoryEntitlementStore(),
    clock: () => new Date("2026-10-14T00:00:00.000Z"),
    receipts: { verify: async () => ({ pro: true }) },
  });
  await entitlements.verifyPro();
  registerBackupRoutes(app, store, {
    isPro: () => entitlements.isPro("cloudBackup"),
  });
  const put = await app.inject({
    method: "PUT",
    url: "/backup/objects/open-object",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("ciphertext"),
  });
  assert.equal(put.statusCode, 200);
});
