import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";
import {
  memoryAuthStore,
  registerAuthRoutes,
  scryptHasher,
  type MailPort,
  type ProviderVerifier,
} from "./index.js";

function build() {
  const app = Fastify();
  const store = memoryAuthStore();
  const sent: { to: string; subject: string; body: string }[] = [];
  const mail: MailPort = {
    async send(to, subject, body) {
      sent.push({ to, subject, body });
    },
  };
  const providers: Record<"google" | "apple", ProviderVerifier> = {
    google: {
      async verify(_provider, idToken) {
        if (!idToken.startsWith("g-")) throw new Error("bad token");
        return { providerAccountId: `google-${idToken.slice(2)}`, email: null };
      },
    },
    apple: {
      async verify(_provider, idToken) {
        if (!idToken.startsWith("a-")) throw new Error("bad token");
        return { providerAccountId: `apple-${idToken.slice(2)}`, email: null };
      },
    },
  };
  registerAuthRoutes(app, store, {
    mail,
    providers,
    hasher: scryptHasher({ n: 2 }),
  });
  const extract = (body: string): string => {
    const match = /: ([A-Za-z0-9_-]+)$/.exec(body);
    if (match === null) throw new Error("no token in mail body");
    return match[1];
  };
  return { app, store, sent, extract };
}

const post = (app: ReturnType<typeof Fastify>, url: string, payload: unknown, token?: string) =>
  app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

test("anonymous accounts are opt-in sessions with email linking", async () => {
  const { app } = build();
  const anon = await post(app, "/auth/anonymous", {});
  assert.equal(anon.statusCode, 200);
  const token = anon.json().token as string;
  const session = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json().providers, [{ provider: "anonymous", verified: false }]);
  const linked = await post(app, "/auth/link", { email: "user@example.com", password: "hunter2!!x" }, token);
  assert.equal(linked.statusCode, 200);
  const after = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(
    after.json().providers.some((p: { provider: string }) => p.provider === "email"),
    true,
  );
});

test("email signup verifies through the mail port and signs in", async () => {
  const { app, sent, extract } = build();
  const bad = await post(app, "/auth/sign-up", { email: "nope", password: "longenough1" });
  assert.equal(bad.statusCode, 400);
  const weak = await post(app, "/auth/sign-up", { email: "a@b.co", password: "short" });
  assert.equal(weak.statusCode, 400);
  const created = await post(app, "/auth/sign-up", { email: "a@b.co", password: "longenough1" });
  assert.equal(created.statusCode, 201);
  const verifyToken = extract(sent[0].body);
  const verify = await post(app, "/auth/verify-email", { token: verifyToken });
  assert.equal(verify.statusCode, 200);
  const again = await post(app, "/auth/verify-email", { token: verifyToken });
  assert.equal(again.statusCode, 400); // single use
  const wrong = await post(app, "/auth/sign-in", { email: "a@b.co", password: "wrongpassword" });
  assert.equal(wrong.statusCode, 401);
  const missing = await post(app, "/auth/sign-in", { email: "ghost@b.co", password: "whatever1" });
  assert.deepEqual(missing.json(), wrong.json()); // same shape: no existence leak
  const signed = await post(app, "/auth/sign-in", { email: "a@b.co", password: "longenough1" });
  assert.equal(signed.statusCode, 200);
  assert.equal(typeof signed.json().token, "string");
});

test("logout removes the session, not the account", async () => {
  const { app } = build();
  const signed = await post(app, "/auth/sign-in", { email: "x" as string, password: "y" as string });
  assert.equal(signed.statusCode, 401);
  await post(app, "/auth/sign-up", { email: "keep@b.co", password: "longenough1" });
  const token = (await post(app, "/auth/sign-in", { email: "keep@b.co", password: "longenough1" })).json().token;
  const out = await post(app, "/auth/logout", {}, token);
  assert.equal(out.statusCode, 200);
  assert.equal(out.json().removed, true);
  const dead = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(dead.statusCode, 401);
  // Credentials still work: logout deleted only the session row.
  const back = await post(app, "/auth/sign-in", { email: "keep@b.co", password: "longenough1" });
  assert.equal(back.statusCode, 200);
});

test("linking a provider account owned by another user conflicts", async () => {
  const { app } = build();
  await post(app, "/auth/sign-up", { email: "owner@b.co", password: "longenough1" });
  const anonToken = (await post(app, "/auth/anonymous", {})).json().token;
  const conflict = await post(app, "/auth/link", { email: "owner@b.co" }, anonToken);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "identity-conflict");
});

test("google/apple identities sign in, link, and conflict cleanly", async () => {
  const { app } = build();
  const bad = await post(app, "/auth/oauth", { provider: "google", idToken: "nope" });
  assert.equal(bad.statusCode, 401);
  const first = await post(app, "/auth/oauth", { provider: "google", idToken: "g-1" });
  assert.equal(first.statusCode, 200);
  const anonToken = (await post(app, "/auth/anonymous", {})).json().token;
  const linked = await post(app, "/auth/link", { provider: "apple", idToken: "a-9" }, anonToken);
  assert.equal(linked.statusCode, 200);
  const clash = await post(app, "/auth/link", { provider: "google", idToken: "g-1" }, anonToken);
  assert.equal(clash.statusCode, 409);
  // The google identity still resolves to its original user.
  const again = await post(app, "/auth/oauth", { provider: "google", idToken: "g-1" });
  const sess = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { authorization: `Bearer ${again.json().token}` },
  });
  assert.deepEqual(sess.json().providers, [{ provider: "google", verified: false }]);
});

test("password recovery resets the password and kills old sessions", async () => {
  const { app, sent, extract } = build();
  const unknown = await post(app, "/auth/forgot-password", { email: "ghost@b.co" });
  assert.equal(unknown.statusCode, 200); // no existence leak
  assert.equal(sent.length, 0);
  await post(app, "/auth/sign-up", { email: "r@b.co", password: "longenough1" });
  const token = (await post(app, "/auth/sign-in", { email: "r@b.co", password: "longenough1" })).json().token;
  await post(app, "/auth/forgot-password", { email: "r@b.co" });
  const resetToken = extract(sent[sent.length - 1].body);
  const weak = await post(app, "/auth/reset-password", { token: resetToken, password: "x" });
  assert.equal(weak.statusCode, 400);
  const reset = await post(app, "/auth/reset-password", { token: resetToken, password: "brandnew2!" });
  assert.equal(reset.statusCode, 200);
  const stolen = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(stolen.statusCode, 401); // recovery invalidates live sessions
  const old = await post(app, "/auth/sign-in", { email: "r@b.co", password: "longenough1" });
  assert.equal(old.statusCode, 401);
  const fresh = await post(app, "/auth/sign-in", { email: "r@b.co", password: "brandnew2!" });
  assert.equal(fresh.statusCode, 200);
  const reuse = await post(app, "/auth/reset-password", { token: resetToken, password: "another3!" });
  assert.equal(reuse.statusCode, 400); // tokens are single use
});
