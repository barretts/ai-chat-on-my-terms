import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { memoryAuthStore } from "../auth/index.js";
import { memorySupportStore, registerSupportRoutes } from "./index.js";
const now = () => new Date((clockMs += 1000));
let clockMs = Date.parse("2026-05-01T00:00:00.000Z");

function sessionToken(auth: ReturnType<typeof memoryAuthStore>, userId: string) {
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

function build() {
  const app = Fastify();
  const auth = memoryAuthStore();
  const store = memorySupportStore({
    changelog: [
      { version: "1.2.0", notes: "Added app lock.", releasedAt: "2026-04-02" },
      { version: "1.3.0", notes: "Encrypted backups.", releasedAt: "2026-05-01" },
    ],
  });
  registerSupportRoutes(app, { store, auth, now });
  return { app, auth, store };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("requests round-trip with author vote and public board read", async () => {
  const { app, auth } = build();
  const creator = sessionToken(auth, "alice");
  await creator.install();

  const anon = await app.inject({
    method: "POST",
    url: "/support/requests",
    payload: { kind: "feature-request", title: "Dark schedules", body: "b" },
  });
  assert.equal(anon.statusCode, 401);

  const created = await app.inject({
    method: "POST",
    url: "/support/requests",
    headers: bearer(creator.token),
    payload: {
      kind: "feature-request",
      title: "Dark schedules",
      body: "auto dark mode by time of day",
    },
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;

  const board = await app.inject({ method: "GET", url: "/support/requests" });
  assert.equal(board.json().items.length, 1);
  assert.equal(board.json().items[0].votes, 1);

  const voter = sessionToken(auth, "bob");
  await voter.install();
  const voted = await app.inject({
    method: "POST",
    url: `/support/requests/${id}/vote`,
    headers: bearer(voter.token),
    payload: { up: true },
  });
  assert.deepEqual(voted.json(), { votes: 2, myVote: true });
  const unvoted = await app.inject({
    method: "POST",
    url: `/support/requests/${id}/vote`,
    headers: bearer(voter.token),
    payload: { up: false },
  });
  assert.deepEqual(unvoted.json(), { votes: 1, myVote: false });
});

test("comments and replies validate parents", async () => {
  const { app, auth } = build();
  const alice = sessionToken(auth, "alice");
  const bob = sessionToken(auth, "bob");
  await alice.install();
  await bob.install();
  const created = await app.inject({
    method: "POST",
    url: "/support/requests",
    headers: bearer(alice.token),
    payload: { kind: "support-ticket", title: "Sync stuck", body: "loop" },
  });
  const id = created.json().id;
  const comment = await app.inject({
    method: "POST",
    url: `/support/requests/${id}/comments`,
    headers: bearer(bob.token),
    payload: { body: "me too" },
  });
  assert.equal(comment.statusCode, 200);
  const parentId = comment.json().id;
  const reply = await app.inject({
    method: "POST",
    url: `/support/requests/${id}/comments`,
    headers: bearer(alice.token),
    payload: { body: "working on it", parentId },
  });
  assert.equal(reply.statusCode, 200);
  const badParent = await app.inject({
    method: "POST",
    url: `/support/requests/${id}/comments`,
    headers: bearer(bob.token),
    payload: { body: "x", parentId: "nope" },
  });
  assert.equal(badParent.statusCode, 400);
  const detail = await app.inject({ method: "GET", url: `/support/requests/${id}` });
  assert.equal(detail.json().comments.length, 2);
  assert.equal(
    detail.json().comments.find((c: { id: string }) => c.id === reply.json().id)
      .parentId,
    parentId,
  );
});

test("unread replies clear when marked read", async () => {
  const { app, auth } = build();
  const alice = sessionToken(auth, "alice");
  const bob = sessionToken(auth, "bob");
  await alice.install();
  await bob.install();
  const created = await app.inject({
    method: "POST",
    url: "/support/requests",
    headers: bearer(alice.token),
    payload: { kind: "feature-request", title: "T", body: "b" },
  });
  const id = created.json().id;
  await app.inject({
    method: "POST",
    url: `/support/requests/${id}/comments`,
    headers: bearer(bob.token),
    payload: { body: "reply one" },
  });
  const before = await app.inject({
    method: "GET",
    url: "/support/requests",
    headers: bearer(alice.token),
  });
  assert.equal(before.json().items[0].unreadReplies, 1);
  await app.inject({
    method: "POST",
    url: `/support/requests/${id}/read`,
    headers: bearer(alice.token),
  });
  const after = await app.inject({
    method: "GET",
    url: "/support/requests",
    headers: bearer(alice.token),
  });
  assert.equal(after.json().items[0].unreadReplies, 0);
  await app.inject({
    method: "POST",
    url: `/support/requests/${id}/comments`,
    headers: bearer(bob.token),
    payload: { body: "reply two" },
  });
  const again = await app.inject({
    method: "GET",
    url: "/support/requests",
    headers: bearer(alice.token),
  });
  assert.equal(again.json().items[0].unreadReplies, 1);
});

test("attachments round-trip and unsafe uploads are refused", async () => {
  const { app, auth } = build();
  const alice = sessionToken(auth, "alice");
  await alice.install();
  const created = await app.inject({
    method: "POST",
    url: "/support/requests",
    headers: bearer(alice.token),
    payload: { kind: "support-ticket", title: "Crash", body: "detail" },
  });
  const id = created.json().id;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const up = await app.inject({
    method: "POST",
    url: `/support/requests/${id}/attachments`,
    headers: bearer(alice.token),
    payload: { name: "crash.png", contentType: "image/png", dataBase64: png },
  });
  assert.equal(up.statusCode, 200);
  const down = await app.inject({
    method: "GET",
    url: `/support/attachments/${up.json().id}`,
    headers: bearer(alice.token),
  });
  assert.equal(down.json().contentType, "image/png");
  assert.deepEqual(
    Buffer.from(down.json().dataBase64, "base64"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  const exe = await app.inject({
    method: "POST",
    url: `/support/requests/${id}/attachments`,
    headers: bearer(alice.token),
    payload: {
      name: "payload.exe",
      contentType: "application/x-msdownload",
      dataBase64: "QUJD",
    },
  });
  assert.equal(exe.statusCode, 400);
  assert.equal(exe.json().code, "invalid-attachment");
});

test("changelog and version check drive update prompts", async () => {
  const { app } = build();
  const log = await app.inject({ method: "GET", url: "/support/changelog" });
  assert.equal(log.json().items.length, 2);
  const stale = await app.inject({
    method: "GET",
    url: "/support/version?app=1.2.0",
  });
  assert.deepEqual(stale.json(), { latest: "1.3.0", upToDate: false });
  const fresh = await app.inject({
    method: "GET",
    url: "/support/version?app=1.3.0",
  });
  assert.equal(fresh.json().upToDate, true);
});

test("account deletion wipes support metadata and kills sessions", async () => {
  const { app, auth, store } = build();
  const alice = sessionToken(auth, "alice");
  await alice.install();
  const created = await app.inject({
    method: "POST",
    url: "/support/requests",
    headers: bearer(alice.token),
    payload: { kind: "support-ticket", title: "Bye", body: "erase me" },
  });
  const id = created.json().id;
  await app.inject({
    method: "POST",
    url: `/support/requests/${id}/comments`,
    headers: bearer(alice.token),
    payload: { body: "and this" },
  });
  await app.inject({
    method: "POST",
    url: `/support/requests/${id}/attachments`,
    headers: bearer(alice.token),
    payload: { name: "a.txt", contentType: "text/plain", dataBase64: "aGk=" },
  });
  const gone = await app.inject({
    method: "DELETE",
    url: "/support/account",
    headers: bearer(alice.token),
  });
  assert.deepEqual(gone.json(), { deleted: true });
  const board = await app.inject({ method: "GET", url: "/support/requests" });
  assert.equal(board.json().items.length, 0);
  const detail = await app.inject({ method: "GET", url: `/support/requests/${id}` });
  assert.equal(detail.statusCode, 404);
  assert.deepEqual(await store.commentsOf(id), []);
  const sessionHash = createHash("sha256")
    .update(alice.token)
    .digest("hex");
  assert.equal(await auth.findSession(sessionHash), null);
});
