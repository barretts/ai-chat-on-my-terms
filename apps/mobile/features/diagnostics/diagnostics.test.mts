import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type {
  SQLiteDatabasePort,
  SqliteBindValue,
} from "@locallab/storage-sqlite-core";
import { sharedMobileDatabase } from "../../platform/database";
import { describeError } from "./errors";
import {
  diagnosticOrigin,
  registerDiagnosticSecret,
  sanitizeDiagnosticText,
} from "./sanitization";
import { TRACE_LIMIT, TraceLogger, type TraceMetadata } from "./trace-log";

function databaseFixture() {
  const native = new DatabaseSync(":memory:");
  const raw: SQLiteDatabasePort = {
    execAsync: async (sql) => native.exec(sql),
    runAsync: async (sql, ...params: SqliteBindValue[]) =>
      native.prepare(sql).run(...params),
    getFirstAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      (native.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T,>(sql: string, ...params: SqliteBindValue[]) =>
      native.prepare(sql).all(...params) as T[],
    withTransactionAsync: async () => {
      throw new Error(
        "The production shared database queue owns transactions.",
      );
    },
  };
  const database = sharedMobileDatabase(raw);
  return {
    native,
    database,
    persisted: () =>
      native
        .prepare("SELECT enabled, entries FROM local_diagnostics WHERE id=1")
        .get() as { enabled: number; entries: string } | undefined,
    close: async (...logs: TraceLogger[]) => {
      await Promise.all(logs.map((log) => log.flush()));
      native.close();
    },
  };
}

test("error text removes URL credentials, query parameters, fragments, and opaque references", () => {
  const output = sanitizeDiagnosticText(
    "HTTP 401 for https://fixture-user:fixture-password@api.example.test/v1/models?api_key=fixture-query&question=fixture-question#fixture-fragment " +
      "Bearer fixture-bearer Basic Zml4dHVyZTpzZWNyZXQ= " +
      "sec_00000000-0000-4000-8000-000000000001 sk-fixture-provider-key",
  );
  for (const secret of [
    "fixture-user",
    "fixture-password",
    "fixture-query",
    "fixture-question",
    "fixture-fragment",
    "fixture-bearer",
    "Zml4dHVyZTpzZWNyZXQ=",
    "sec_00000000-0000-4000-8000-000000000001",
    "sk-fixture-provider-key",
  ]) {
    assert.equal(output.includes(secret), false, secret);
  }
  assert.match(output, /HTTP 401/);
  assert.match(output, /https:\/\/api\.example\.test\/v1\/models/);
  assert.equal(
    new URL(
      diagnosticOrigin(
        "https://fixture-user:fixture-password@api.example.test/private-path?key=fixture-query#fixture-fragment",
      )!,
    ).origin,
    "https://api.example.test",
  );
  assert.equal(diagnosticOrigin("file:///fixture-private-file"), undefined);
});

test("quoted JSON credential fields are redacted even before a key is registered", () => {
  const output = sanitizeDiagnosticText(
    'Rejected {"api_key":"fixture-json-api", "X-Api-Key":"fixture-json-header", "password":"fixture-json-password", "token":"fixture-json-token", "Authorization":"opaque-fixture-auth"}',
  );
  for (const secret of [
    "fixture-json-api",
    "fixture-json-header",
    "fixture-json-password",
    "fixture-json-token",
    "opaque-fixture-auth",
  ]) {
    assert.equal(output.includes(secret), false, secret);
  }
  assert.match(output, /Rejected/);
});

test("escaped quotes in echoed JSON credential values do not leave a secret suffix", () => {
  const output = sanitizeDiagnosticText(
    "Rejected " +
      JSON.stringify({ "X-Api-Key": 'fixture-prefix"fixture-secret-suffix' }),
  );
  assert.equal(output.includes("fixture-prefix"), false);
  assert.equal(output.includes("fixture-secret-suffix"), false);
});

test("registered arbitrary custom-header values are redacted in plain and nested error causes", () => {
  const customHeaderValue = "fixture-arbitrary-header-material-947";
  registerDiagnosticSecret(customHeaderValue);
  const inner = new Error(
    `Upstream rejected X-Fixture-Auth: ${customHeaderValue}; HTTP 403`,
  );
  const error = new Error("Model discovery failed", { cause: inner });
  const output = describeError(error, {
    operation: "Load endpoint models",
    recovery: "Enter the server key again, then load models.",
  });
  assert.match(output, /Load endpoint models failed/);
  assert.match(output, /Model discovery failed/);
  assert.match(output, /HTTP 403/);
  assert.match(output, /Enter the server key again/);
  assert.equal(output.includes(customHeaderValue), false);
  assert.equal(
    sanitizeDiagnosticText(`Unknown header ${customHeaderValue}`),
    "Unknown header [REDACTED]",
  );
});

test("registered custom-header values are redacted when a provider JSON-escapes them", () => {
  const customHeaderValue = 'fixture-quoted-header-"-private-tail';
  registerDiagnosticSecret(customHeaderValue);
  const output = sanitizeDiagnosticText(
    JSON.stringify({
      error: `Rejected X-Fixture-Auth value ${customHeaderValue}`,
    }),
  );
  assert.equal(output.includes("fixture-quoted-header"), false);
  assert.equal(output.includes("private-tail"), false);
});

test("error formatting terminates on a cyclic cause and does not stringify arbitrary payload fields", () => {
  const error = Object.assign(new Error("Fixture root cause"), {
    payload: "fixture-private-prompt-contents",
    headers: { "X-Fixture-Auth": "fixture-private-header-contents" },
  }) as Error & { cause?: unknown };
  error.cause = error;
  const output = describeError(error, {
    operation: "Send message",
    recovery: "Retry the message.",
  });
  assert.match(output, /Fixture root cause/);
  assert.match(output, /Retry the message/);
  assert.equal(output.includes("fixture-private-prompt-contents"), false);
  assert.equal(output.includes("fixture-private-header-contents"), false);
  assert.ok(output.length < 2000);
});

test("full structured responses and separately exposed HTTP bodies survive display and redaction", () => {
  const key = "fixture-full-response-secret-531";
  registerDiagnosticSecret(key);
  const response = {
    status: 503,
    failure: {
      reason: "No detail in message field",
      diagnostic: "long detail ".repeat(1500),
      end: "FINAL-RESPONSE-FIELD",
      api_key: key,
    },
  };
  const output = describeError(response, {
    operation: "Send message",
    recovery: "Try again.",
  });
  assert.match(output, /No detail in message field/);
  assert.match(output, /FINAL-RESPONSE-FIELD/);
  assert.ok(output.length > 8192);
  assert.equal(output.includes(key), false);
  const nativeError = Object.assign(new Error("Native request failed"), {
    status: 502,
    responseBody: "COMPLETE-NATIVE-RESPONSE",
    cause: response,
  });
  const nested = describeError(nativeError, {
    operation: "Download model",
    recovery: "Retry the download.",
  });
  assert.match(nested, /HTTP 502/);
  assert.match(nested, /COMPLETE-NATIVE-RESPONSE/);
  assert.match(nested, /FINAL-RESPONSE-FIELD/);
  assert.equal(nested.includes(key), false);
});

test("trace recording is off by default and pre-consent events never persist", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  try {
    log.event("Before storage", "failed");
    await log.initialize(fixture.database);
    log.event("Before consent", "failed", { status: 401 });
    await log.flush();
    assert.equal(log.getSnapshot().ready, true);
    assert.equal(log.getSnapshot().enabled, false);
    assert.deepEqual(log.getSnapshot().entries, []);
    assert.equal(fixture.persisted(), undefined);
    assert.deepEqual(JSON.parse(log.export()).entries, []);
  } finally {
    await fixture.close(log);
  }
});

test("enabled trace survives a new logger and disabled recording retains only previous entries", async () => {
  const fixture = databaseFixture();
  const first = new TraceLogger();
  const reopened = new TraceLogger();
  const offReopened = new TraceLogger();
  try {
    await first.initialize(fixture.database);
    await first.setEnabled(true);
    first.event("HTTP request", "failed", {
      code: "offline",
      status: 503,
      method: "GET",
      endpoint:
        "https://fixture-user:fixture-pass@api.example.test/private-path?key=fixture-query",
      durationMs: 24.6,
    });
    await first.flush();
    assert.equal(fixture.persisted()?.enabled, 1);
    await reopened.initialize(fixture.database);
    assert.equal(reopened.getSnapshot().enabled, true);
    const detail = reopened
      .getSnapshot()
      .entries.find((entry) => entry.operation === "HTTP request")!.detail;
    assert.equal(new URL(detail.endpoint!).origin, "https://api.example.test");
    assert.deepEqual(
      { ...detail, endpoint: undefined },
      {
        code: "offline",
        status: 503,
        method: "GET",
        endpoint: undefined,
        durationMs: 25,
      },
    );
    await reopened.setEnabled(false);
    const before = reopened.getSnapshot();
    reopened.event("After consent withdrawn", "failed");
    await reopened.flush();
    assert.deepEqual(reopened.getSnapshot(), before);
    await offReopened.initialize(fixture.database);
    assert.equal(offReopened.getSnapshot().enabled, false);
    assert.equal(
      offReopened
        .getSnapshot()
        .entries.some((entry) => entry.operation === "HTTP request"),
      true,
    );
    assert.equal(
      offReopened
        .getSnapshot()
        .entries.some((entry) => entry.operation === "After consent withdrawn"),
      false,
    );
  } finally {
    await fixture.close(first, reopened, offReopened);
  }
});

test("unexpected payload fields and uncategorized error metadata cannot enter persisted trace or export", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  const key = "fixture-known-trace-header-682";
  registerDiagnosticSecret(key);
  try {
    await log.initialize(fixture.database);
    await log.setEnabled(true);
    log.event(`Fixture request rejected ${key}`, "failed", {
      code: "fixture-private-credential",
      errorName: "fixturePrivateCredential",
      status: 401,
      method: "POST",
      endpoint:
        "https://fixture-user:fixture-password@api.example.test/v1?api_key=fixture-query",
      headers: { "X-Fixture-Auth": key },
      apiKey: key,
      error: "fixture-raw-error-body",
      prompt: "fixture-private-message",
    } as TraceMetadata);
    await log.flush();
    const exported = log.export();
    const persisted = fixture.persisted()!.entries;
    for (const output of [exported, persisted]) {
      for (const secret of [
        key,
        "fixture-private-credential",
        "fixturePrivateCredential",
        "fixture-user",
        "fixture-password",
        "fixture-query",
        "fixture-raw-error-body",
        "fixture-private-message",
      ]) {
        assert.equal(output.includes(secret), false, secret);
      }
    }
    const event = log.getSnapshot().entries.at(-1)!;
    assert.equal(
      new URL(event.detail.endpoint!).origin,
      "https://api.example.test",
    );
    assert.deepEqual(
      { ...event.detail, endpoint: undefined },
      {
        code: "other",
        errorName: "Error",
        status: 401,
        method: "POST",
        endpoint: undefined,
      },
    );
  } finally {
    await fixture.close(log);
  }
});

test("trace memory and persisted rows remain bounded to the latest events", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  try {
    await log.initialize(fixture.database);
    await log.setEnabled(true);
    for (let index = 0; index < TRACE_LIMIT + 30; index += 1) {
      log.event(`Fixture operation ${index}`, "complete", {
        durationMs: index,
      });
    }
    await log.flush();
    const entries = log.getSnapshot().entries;
    assert.equal(entries.length, TRACE_LIMIT);
    assert.equal(entries[0]?.operation, "Fixture operation 30");
    assert.equal(
      entries.at(-1)?.operation,
      `Fixture operation ${TRACE_LIMIT + 29}`,
    );
    assert.deepEqual(JSON.parse(fixture.persisted()!.entries), entries);
    assert.equal(JSON.parse(log.export()).entries.length, TRACE_LIMIT);
  } finally {
    await fixture.close(log);
  }
});

test("clear removes queued previous events from memory, export and a fresh logger", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  const reopened = new TraceLogger();
  try {
    await log.initialize(fixture.database);
    await log.setEnabled(true);
    log.event("Queued before clear", "failed", { status: 500 });
    await log.clear();
    await log.flush();
    assert.deepEqual(log.getSnapshot().entries, []);
    assert.deepEqual(JSON.parse(log.export()).entries, []);
    assert.deepEqual(JSON.parse(fixture.persisted()!.entries), []);
    await log.setEnabled(false);
    await reopened.initialize(fixture.database);
    assert.deepEqual(reopened.getSnapshot().entries, []);
  } finally {
    await fixture.close(log, reopened);
  }
});

test("turning recording off excludes events produced while the preference write is pending", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  try {
    await log.initialize(fixture.database);
    await log.setEnabled(true);
    const disabling = log.setEnabled(false);
    log.event("Fixture event after toggle off", "failed");
    await disabling;
    await log.flush();
    assert.equal(log.getSnapshot().enabled, false);
    assert.equal(
      log.export().includes("Fixture event after toggle off"),
      false,
    );
    assert.equal(
      fixture.persisted()!.entries.includes("Fixture event after toggle off"),
      false,
    );
    assert.equal(fixture.persisted()!.enabled, 0);
  } finally {
    await fixture.close(log);
  }
});

test("clear preserves new events received while its storage write is pending", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  try {
    await log.initialize(fixture.database);
    await log.setEnabled(true);
    log.event("Fixture obsolete event", "failed");
    const clearing = log.clear();
    log.event("Fixture event during clear", "complete");
    await clearing;
    await log.flush();
    assert.equal(log.export().includes("Fixture obsolete event"), false);
    assert.equal(log.export().includes("Fixture event during clear"), true);
    assert.deepEqual(
      JSON.parse(fixture.persisted()!.entries),
      log.getSnapshot().entries,
    );
  } finally {
    await fixture.close(log);
  }
});

test("an unreadable saved trace remains recoverable through a visible storage error and clear", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  const reopened = new TraceLogger();
  try {
    fixture.native.exec(
      "CREATE TABLE local_diagnostics (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, entries TEXT NOT NULL); INSERT INTO local_diagnostics VALUES (1, 1, '{');",
    );
    await log.initialize(fixture.database);
    assert.equal(log.getSnapshot().ready, true);
    assert.match(log.getSnapshot().storageError, /unreadable/i);
    assert.deepEqual(log.getSnapshot().entries, []);
    await log.clear();
    await log.setEnabled(false);
    assert.equal(log.getSnapshot().storageError, "");
    await reopened.initialize(fixture.database);
    assert.equal(reopened.getSnapshot().ready, true);
    assert.equal(reopened.getSnapshot().storageError, "");
    assert.deepEqual(reopened.getSnapshot().entries, []);
  } finally {
    await fixture.close(log, reopened);
  }
});

test("previously saved trace entries are re-sanitized before display and export", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  try {
    fixture.native.exec(
      "CREATE TABLE local_diagnostics (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, entries TEXT NOT NULL);",
    );
    const entries = [
      {
        time: "2026-09-29T00:00:00.000Z",
        operation: "Request Bearer fixture-persisted-bearer",
        phase: "failed",
        detail: {
          code: "fixture-persisted-key",
          errorName: "fixturePersistedKey",
          status: 401,
          endpoint:
            "https://fixture-user:fixture-password@api.example.test/path?key=fixture-query",
          headers: { "X-Fixture-Auth": "fixture-persisted-header" },
          prompt: "fixture-persisted-prompt",
        },
      },
      {
        time: "not-a-date",
        operation: "Fixture invalid time",
        phase: "failed",
        detail: {},
      },
      {
        time: "2026-09-29T00:00:00.000Z",
        operation: "Fixture invalid phase",
        phase: "fixture-private-phase",
        detail: {},
      },
    ];
    fixture.native
      .prepare("INSERT INTO local_diagnostics VALUES (1, 0, ?)")
      .run(JSON.stringify(entries));
    await log.initialize(fixture.database);
    assert.equal(log.getSnapshot().entries.length, 1);
    const exported = log.export();
    for (const secret of [
      "fixture-persisted-bearer",
      "fixture-persisted-key",
      "fixturePersistedKey",
      "fixture-user",
      "fixture-password",
      "fixture-query",
      "fixture-persisted-header",
      "fixture-persisted-prompt",
      "Fixture invalid time",
      "Fixture invalid phase",
    ]) {
      assert.equal(exported.includes(secret), false, secret);
    }
    assert.equal(log.getSnapshot().enabled, false);
  } finally {
    await fixture.close(log);
  }
});

test("a failed SQLite trace write produces an explicit recoverable storage error", async () => {
  const fixture = databaseFixture();
  const log = new TraceLogger();
  const privateValue = "fixture-native-write-secret-581";
  registerDiagnosticSecret(privateValue);
  try {
    await log.initialize(fixture.database);
    await log.setEnabled(true);
    await log.flush();
    fixture.native.exec(
      `CREATE TRIGGER reject_diagnostics_fixture BEFORE INSERT ON local_diagnostics BEGIN SELECT RAISE(ABORT, '${privateValue} disk full'); END;`,
    );
    log.event("Fixture failed persistence", "failed", { code: "SQLITE_FULL" });
    await log.flush();
    assert.match(
      log.getSnapshot().storageError,
      /Trace log could not be saved/,
    );
    assert.match(log.getSnapshot().storageError, /disk full/);
    assert.equal(log.getSnapshot().storageError.includes(privateValue), false);
    fixture.native.exec("DROP TRIGGER reject_diagnostics_fixture");
    await log.clear();
    assert.equal(log.getSnapshot().storageError, "");
    assert.deepEqual(JSON.parse(fixture.persisted()!.entries), []);
  } finally {
    await fixture.close(log);
  }
});
