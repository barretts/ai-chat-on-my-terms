import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "vitest";
import { installAbortSignalPatch } from "../node_modules/expo/src/winter/AbortSignal";
import { DOMException as ExpoDOMException } from "../node_modules/expo/src/winter/DOMException";
import { ForegroundRunAdmission } from "../composition/chat/foreground";
import { installNativeAbortCompatibility } from "./abort-compatibility";
import { installNativeAbortCompatibility as installWebCompatibility } from "./abort-compatibility.web";

const require = createRequire(import.meta.url);
const rnRequire = createRequire(require.resolve("react-native/package.json"));
// The actual constructor imported by installed RN's Libraries/Core/setUpXHR.js.
const native = rnRequire("abort-controller/dist/abort-controller") as {
  AbortController: typeof globalThis.AbortController;
  AbortSignal: typeof globalThis.AbortSignal;
};

test("installed native AbortController supports admission checks, first reasons and Expo any propagation", async () => {
  assert.equal(rnRequire("abort-controller/package.json").version, "3.0.0");
  assert.equal(require("expo/package.json").version, "57.0.25");
  const originalController = globalThis.AbortController;
  const originalSignal = globalThis.AbortSignal;
  const originalDOMException = globalThis.DOMException;
  globalThis.AbortController = native.AbortController;
  globalThis.AbortSignal = native.AbortSignal;
  globalThis.DOMException = ExpoDOMException as typeof globalThis.DOMException;
  try {
    // SDK bootstrap adds static methods before the layout installs the instance fallback.
    installAbortSignalPatch(native.AbortSignal);
    const beforeBootstrap = new native.AbortController();
    assert.equal(typeof beforeBootstrap.signal.throwIfAborted, "undefined");
    beforeBootstrap.abort(
      new Error("The old constructor discards this reason"),
    );
    assert.equal(beforeBootstrap.signal.reason, undefined);
    installNativeAbortCompatibility();
    const installedAbort = native.AbortController.prototype.abort;
    const installedCheck = native.AbortSignal.prototype.throwIfAborted;
    installNativeAbortCompatibility();
    assert.equal(native.AbortController.prototype.abort, installedAbort);
    assert.equal(native.AbortSignal.prototype.throwIfAborted, installedCheck);

    const active = new native.AbortController();
    assert.equal(active.signal.reason, undefined);
    assert.doesNotThrow(() => active.signal.throwIfAborted());
    const admission = new ForegroundRunAdmission(() => true).begin();
    let dispatches = 0;
    const handle = { stop: async () => {} };
    assert.equal(
      await admission.admit(async () => {
        active.signal.throwIfAborted();
        dispatches++;
        return handle;
      }),
      handle,
    );
    assert.equal(dispatches, 1);

    const combined = native.AbortSignal.any([active.signal]);
    const reason = new DOMException("Stopped by the user", "AbortError");
    let reasonDuringEvent: unknown;
    active.signal.addEventListener("abort", () => {
      reasonDuringEvent = active.signal.reason;
    });
    active.abort(reason);
    assert.equal(reasonDuringEvent, reason);
    assert.equal(active.signal.reason, reason);
    assert.equal(combined.reason, reason);
    assert.throws(
      () => active.signal.throwIfAborted(),
      (error) => error === reason,
    );
    assert.throws(
      () => combined.throwIfAborted(),
      (error) => error === reason,
    );
    await assert.rejects(
      admission.admit(async () => {
        active.signal.throwIfAborted();
        dispatches++;
        return handle;
      }),
      (error) => error === reason && error.name === "AbortError",
    );
    assert.equal(dispatches, 1);
    active.abort(new Error("A second abort must not replace the first"));
    assert.equal(active.signal.reason, reason);
    assert.equal(combined.reason, reason);

    const alreadyCombined = native.AbortSignal.any([active.signal]);
    assert.throws(
      () => alreadyCombined.throwIfAborted(),
      (error) => error === reason,
    );
    const defaultAbort = new native.AbortController();
    defaultAbort.abort();
    const defaultReason = defaultAbort.signal.reason;
    assert.ok(defaultReason instanceof ExpoDOMException);
    assert.equal(defaultReason.name, "AbortError");
    assert.equal(defaultAbort.signal.reason, defaultReason);
    assert.throws(
      () => defaultAbort.signal.throwIfAborted(),
      (error) => error === defaultReason,
    );
    assert.equal(beforeBootstrap.signal.reason.name, "AbortError");
    const earlierReason = beforeBootstrap.signal.reason;
    assert.throws(
      () => beforeBootstrap.signal.throwIfAborted(),
      (error) => error === earlierReason,
    );

    const explicitNull = new native.AbortController();
    explicitNull.abort(null);
    assert.equal(explicitNull.signal.reason, null);
    let caught: unknown = "not thrown";
    try {
      explicitNull.signal.throwIfAborted();
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, null);
  } finally {
    globalThis.AbortController = originalController;
    globalThis.AbortSignal = originalSignal;
    globalThis.DOMException = originalDOMException;
  }
});

test("conforming constructors and the browser bootstrap stay unchanged", () => {
  const abort = AbortController.prototype.abort;
  const check = AbortSignal.prototype.throwIfAborted;
  const reasonGetter = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "reason",
  )!.get;
  installNativeAbortCompatibility();
  installWebCompatibility();
  assert.equal(AbortController.prototype.abort, abort);
  assert.equal(AbortSignal.prototype.throwIfAborted, check);
  assert.equal(
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")!.get,
    reasonGetter,
  );
});
