/** Optional accounts (AC-01) and email password recovery (AC-02).
 * Anonymous sessions are opt-in: a local-only user never contacts this
 * service at all, and nothing here stores or touches local chats.
 * Session tokens, verification tokens, and reset tokens are stored only
 * as SHA-256 hashes; a leaked table cannot mint sessions. */

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export type IdentityProvider = "anonymous" | "email" | "google" | "apple";

export interface AuthUser {
  id: string;
  createdAt: string;
}

export interface AuthIdentity {
  userId: string;
  provider: IdentityProvider;
  /** Email address, store subject, or "anonymous:<uuid>". */
  providerAccountId: string;
  /** scrypt "salt:hash" hex; only for the email provider. */
  passwordCredential: string | null;
  emailVerified: boolean;
}

export interface AuthSession {
  tokenHash: string;
  userId: string;
  createdAt: string;
}

export interface PendingEmailVerification {
  tokenHash: string;
  email: string;
  userId: string;
  createdAt: string;
}

export interface AuthStore {
  insertUser(user: AuthUser): Promise<void>;
  insertIdentity(identity: AuthIdentity): Promise<void>;
  findIdentity(
    provider: IdentityProvider,
    providerAccountId: string,
  ): Promise<AuthIdentity | null>;
  identitiesOf(userId: string): Promise<AuthIdentity[]>;
  findUserByEmail(email: string): Promise<AuthUser | null>;
  insertSession(session: AuthSession): Promise<void>;
  findSession(tokenHash: string): Promise<AuthSession | null>;
  deleteSession(tokenHash: string): Promise<boolean>;
  insertPendingEmail(pending: PendingEmailVerification): Promise<void>;
  findPendingEmail(tokenHash: string): Promise<PendingEmailVerification | null>;
  deletePendingEmail(tokenHash: string): Promise<void>;
  setPasswordCredential(
    provider: "email",
    providerAccountId: string,
    credential: string,
  ): Promise<void>;
  deleteSessionsOf(userId: string): Promise<void>;
  markEmailVerified(providerAccountId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

/** Outbound email only; the production transport is external (pending). */
export interface MailPort {
  send(to: string, subject: string, body: string): Promise<void>;
}

/** Verifies provider id tokens (Google/Apple). Production JWKS verification
 * needs client ids/keys and is external; tests inject a double. */
export interface ProviderVerifier {
  verify(provider: "google" | "apple", idToken: string): Promise<{
    providerAccountId: string;
    email: string | null;
  }>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, credential: string): Promise<boolean>;
}

export function scryptHasher(params: { n?: number } = {}): PasswordHasher {
  const n = params.n ?? 16384;
  return {
    async hash(password) {
      const salt = randomBytes(16);
      const derived = await scryptAsync(password, salt, 32, n);
      return `${salt.toString("hex")}:${derived.toString("hex")}`;
    },
    async verify(password, credential) {
      const [saltHex, hashHex] = credential.split(":");
      if (saltHex === undefined || hashHex === undefined) return false;
      const derived = await scryptAsync(
        password,
        Buffer.from(saltHex, "hex"),
        hashHex.length / 2,
        n,
      );
      const expected = Buffer.from(hashHex, "hex");
      return (
        derived.length === expected.length && timingSafeEqual(derived, expected)
      );
    },
  };
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  n: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: n, r: 8, p: 1 }, (error, value) =>
      error === null ? resolve(value) : reject(error),
    );
  });
}

export function memoryAuthStore(): AuthStore {
  const users = new Map<string, AuthUser>();
  const identities: AuthIdentity[] = [];
  const sessions = new Map<string, AuthSession>();
  const pending = new Map<string, PendingEmailVerification>();
  return {
    async insertUser(user) {
      users.set(user.id, user);
    },
    async insertIdentity(identity) {
      identities.push({ ...identity });
    },
    async findIdentity(provider, providerAccountId) {
      const normalized = normalizeEmailKey(provider, providerAccountId);
      const found = identities.find(
        (identity) =>
          identity.provider === provider &&
          normalizeEmailKey(identity.provider, identity.providerAccountId) ===
            normalized,
      );
      return found === undefined ? null : { ...found };
    },
    async identitiesOf(userId) {
      return identities
        .filter((identity) => identity.userId === userId)
        .map((identity) => ({ ...identity }));
    },
    async findUserByEmail(email) {
      const identity = identities.find(
        (item) =>
          item.provider === "email" &&
          item.providerAccountId.toLowerCase() === email.toLowerCase(),
      );
      if (identity === undefined) return null;
      return users.get(identity.userId) ?? null;
    },
    async insertSession(session) {
      sessions.set(session.tokenHash, { ...session });
    },
    async findSession(tokenHash) {
      const found = sessions.get(tokenHash);
      return found === undefined ? null : { ...found };
    },
    async deleteSession(tokenHash) {
      return sessions.delete(tokenHash);
    },
    async deleteSessionsOf(userId) {
      for (const [tokenHash, session] of [...sessions.entries()])
        if (session.userId === userId) sessions.delete(tokenHash);
    },
    async insertPendingEmail(record) {
      pending.set(record.tokenHash, { ...record });
    },
    async findPendingEmail(tokenHash) {
      const found = pending.get(tokenHash);
      return found === undefined ? null : { ...found };
    },
    async deletePendingEmail(tokenHash) {
      pending.delete(tokenHash);
    },
    async setPasswordCredential(_provider, providerAccountId, credential) {
      const identity = identities.find(
        (item) =>
          item.provider === "email" &&
          item.providerAccountId.toLowerCase() ===
            providerAccountId.toLowerCase(),
      );
      if (identity !== undefined) identity.passwordCredential = credential;
    },
    async markEmailVerified(providerAccountId) {
      const identity = identities.find(
        (item) =>
          item.provider === "email" &&
          item.providerAccountId.toLowerCase() ===
            providerAccountId.toLowerCase(),
      );
      if (identity !== undefined) identity.emailVerified = true;
    },
    async deleteUser(userId) {
      users.delete(userId);
      for (let i = identities.length - 1; i >= 0; i--)
        if (identities[i]?.userId === userId) identities.splice(i, 1);
      for (const [tokenHash, session] of [...sessions.entries()])
        if (session.userId === userId) sessions.delete(tokenHash);
      for (const [tokenHash, record] of [...pending.entries()])
        if (record.userId === userId) pending.delete(tokenHash);
    },
  };
}

function normalizeEmailKey(
  provider: IdentityProvider,
  providerAccountId: string,
): string {
  return provider === "email"
    ? providerAccountId.toLowerCase()
    : providerAccountId;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface RegisterAuthRoutesOptions {
  mail: MailPort;
  providers: Partial<
    Record<"google" | "apple", ProviderVerifier | undefined>
  >;
  hasher?: PasswordHasher;
  now?: () => Date;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  store: AuthStore = memoryAuthStore(),
  options: RegisterAuthRoutesOptions,
): void {
  const hasher = options.hasher ?? scryptHasher();
  const now = options.now ?? (() => new Date());

  async function issueSession(userId: string): Promise<string> {
    const token = newToken();
    await store.insertSession({
      tokenHash: hashToken(token),
      userId,
      createdAt: now().toISOString(),
    });
    return token;
  }

  async function sessionUser(
    request: {
      headers: { authorization?: string };
    },
  ): Promise<AuthUser | null> {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return null;
    const session = await store.findSession(hashToken(header.slice(7)));
    if (session === null) return null;
    // Sessions are the account proof; deletion is session removal only.
    return { id: session.userId, createdAt: session.createdAt };
  }

  async function createUserWithIdentity(
    provider: IdentityProvider,
    providerAccountId: string,
    passwordCredential: string | null = null,
    emailVerified = false,
  ): Promise<string> {
    const user: AuthUser = { id: randomUUID(), createdAt: now().toISOString() };
    await store.insertUser(user);
    await store.insertIdentity({
      userId: user.id,
      provider,
      providerAccountId,
      passwordCredential,
      emailVerified,
    });
    return user.id;
  }

  app.post("/auth/anonymous", async (_request, reply) => {
    const userId = await createUserWithIdentity(
      "anonymous",
      `anonymous:${randomUUID()}`,
    );
    return reply.code(200).send({ token: await issueSession(userId) });
  });

  app.post("/auth/sign-up", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    const email = body.email?.trim() ?? "";
    const password = body.password ?? "";
    if (!EMAIL.test(email))
      return reply.code(400).send({ code: "malformed-email" });
    if (password.length < 8)
      return reply.code(400).send({ code: "weak-password" });
    if ((await store.findIdentity("email", email)) !== null)
      return reply.code(409).send({ code: "email-taken" });
    const credential = await hasher.hash(password);
    const userId = await createUserWithIdentity(
      "email",
      email,
      credential,
      false,
    );
    const token = newToken();
    await store.insertPendingEmail({
      tokenHash: hashToken(token),
      email,
      userId,
      createdAt: now().toISOString(),
    });
    await options.mail.send(
      email,
      "Verify your LocalLab email",
      `Confirm with this code: ${token}`,
    );
    return reply.code(201).send({ sent: true });
  });

  app.post("/auth/verify-email", async (request, reply) => {
    const body = request.body as { token?: string };
    if (body.token === undefined)
      return reply.code(400).send({ code: "missing-token" });
    const pending = await store.findPendingEmail(hashToken(body.token));
    if (pending === null)
      return reply.code(400).send({ code: "invalid-token" });
    await store.deletePendingEmail(hashToken(body.token));
    await store.markEmailVerified(pending.email);
    return reply.code(200).send({ verified: true });
  });

  app.post("/auth/sign-in", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    const identity = await store.findIdentity("email", body.email ?? "");
    if (
      identity === null ||
      identity.passwordCredential === null ||
      !(await hasher.verify(body.password ?? "", identity.passwordCredential))
    )
      // Identical failure for unknown email and wrong password.
      return reply.code(401).send({ code: "invalid-credentials" });
    return reply
      .code(200)
      .send({ token: await issueSession(identity.userId) });
  });

  app.post("/auth/oauth", async (request, reply) => {
    const body = request.body as {
      provider?: "google" | "apple";
      idToken?: string;
    };
    const provider = body.provider;
    if (provider !== "google" && provider !== "apple")
      return reply.code(400).send({ code: "unsupported-provider" });
    const verifier = options.providers[provider];
    if (verifier === undefined)
      return reply.code(400).send({ code: "unsupported-provider" });
    if (body.idToken === undefined)
      return reply.code(400).send({ code: "missing-id-token" });
    let verified: Awaited<ReturnType<ProviderVerifier["verify"]>>;
    try {
      verified = await verifier.verify(provider, body.idToken);
    } catch {
      return reply.code(401).send({ code: "invalid-id-token" });
    }
    const identity = await store.findIdentity(
      provider,
      verified.providerAccountId,
    );
    if (identity === null) {
      const userId = await createUserWithIdentity(
        provider,
        verified.providerAccountId,
      );
      return reply.code(200).send({ token: await issueSession(userId) });
    }
    return reply
      .code(200)
      .send({ token: await issueSession(identity.userId) });
  });

  /** Link another identity to the signed-in account. A provider account
   * already attached to a different user conflicts (AC-01 linking). */
  app.post("/auth/link", async (request, reply) => {
    const current = await sessionUser(request);
    if (current === null) return reply.code(401).send({ code: "no-session" });
    const body = request.body as {
      provider?: "google" | "apple";
      idToken?: string;
      email?: string;
      password?: string;
    };
    if (body.provider === "google" || body.provider === "apple") {
      const verifier = options.providers[body.provider];
      if (verifier === undefined || body.idToken === undefined)
        return reply.code(400).send({ code: "unsupported-provider" });
      let verified: Awaited<ReturnType<ProviderVerifier["verify"]>>;
      try {
        verified = await verifier.verify(body.provider, body.idToken);
      } catch {
        return reply.code(401).send({ code: "invalid-id-token" });
      }
      const existing = await store.findIdentity(
        body.provider,
        verified.providerAccountId,
      );
      if (existing !== null && existing.userId !== current.id)
        return reply.code(409).send({ code: "identity-conflict" });
      if (existing !== null) return reply.code(200).send({ linked: true });
      await store.insertIdentity({
        userId: current.id,
        provider: body.provider,
        providerAccountId: verified.providerAccountId,
        passwordCredential: null,
        emailVerified: true,
      });
      return reply.code(200).send({ linked: true });
    }
    const email = body.email?.trim() ?? "";
    if (!EMAIL.test(email))
      return reply.code(400).send({ code: "malformed-email" });
    const existing = await store.findIdentity("email", email);
    if (existing !== null && existing.userId !== current.id)
      return reply.code(409).send({ code: "identity-conflict" });
    if (existing !== null) return reply.code(200).send({ linked: true });
    await store.insertIdentity({
      userId: current.id,
      provider: "email",
      providerAccountId: email,
      passwordCredential:
        body.password === undefined
          ? null
          : await hasher.hash(body.password),
      emailVerified: false,
    });
    const token = newToken();
    await store.insertPendingEmail({
      tokenHash: hashToken(token),
      email,
      userId: current.id,
      createdAt: now().toISOString(),
    });
    await options.mail.send(
      email,
      "Verify your LocalLab email",
      `Confirm with this code: ${token}`,
    );
    return reply.code(200).send({ linked: true });
  });

  app.get("/auth/session", async (request, reply) => {
    const current = await sessionUser(request);
    if (current === null) return reply.code(401).send({ code: "no-session" });
    const identities = await store.identitiesOf(current.id);
    return reply.code(200).send({
      userId: current.id,
      providers: identities.map((identity) => ({
        provider: identity.provider,
        verified: identity.emailVerified,
      })),
    });
  });

  /** Server-side session removal; local chats live on the device and are
   * never deleted by this endpoint. */
  app.post("/auth/logout", async (request, reply) => {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer "))
      return reply.code(401).send({ code: "no-session" });
    const removed = await store.deleteSession(hashToken(header.slice(7)));
    return reply.code(200).send({ removed });
  });

  /** AC-02: always reports success so account existence is not leaked. */
  app.post("/auth/forgot-password", async (request, reply) => {
    const body = request.body as { email?: string };
    const user = await store.findUserByEmail(body.email ?? "");
    if (user !== null && body.email !== undefined) {
      const token = newToken();
      await store.insertPendingEmail({
        tokenHash: hashToken(token),
        email: body.email,
        userId: user.id,
        createdAt: now().toISOString(),
      });
      await options.mail.send(
        body.email,
        "Reset your LocalLab password",
        `Use this code to choose a new password: ${token}`,
      );
    }
    return reply.code(200).send({ sent: true });
  });

  app.post("/auth/reset-password", async (request, reply) => {
    const body = request.body as { token?: string; password?: string };
    const password = body.password ?? "";
    if (password.length < 8)
      return reply.code(400).send({ code: "weak-password" });
    if (body.token === undefined)
      return reply.code(400).send({ code: "missing-token" });
    const pending = await store.findPendingEmail(hashToken(body.token));
    if (pending === null)
      return reply.code(400).send({ code: "invalid-token" });
    await store.deletePendingEmail(hashToken(body.token));
    await store.setPasswordCredential("email", pending.email, await hasher.hash(password));
    // Recovery invalidates all sessions: a reset means a stolen session.
    await store.deleteSessionsOf(pending.userId);
    return reply.code(200).send({ reset: true });
  });
}
