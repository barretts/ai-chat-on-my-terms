// Vendored from @tauri-apps/api 2.0.0 (`tooling/api/src/core.ts` at the
// tauri-v2.0.0 release commit, as published to npm as core.js).
// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
//
// Only the `invoke` / `transformCallback` primitives are vendored here, with
// the wire contract kept identical: both are thin delegations to
// `window.__TAURI_INTERNALS__`, which the Tauri v2 runtime injects into the
// webview and which owns the actual `postMessage` protocol. Do not reimplement
// that protocol in app code; adapt only the TypeScript surface (the official
// package ships a global.d.ts ambient declaration; we keep one in this module
// instead of depending on the package).

interface TauriInvokeOptions {
  headers: Headers | Record<string, string>;
}

type TauriInvokeArgs =
  | Record<string, unknown>
  | number[]
  | ArrayBuffer
  | Uint8Array;

interface TauriInternals {
  transformCallback<T = unknown>(
    callback?: (response: T) => void,
    once?: boolean,
  ): number;
  invoke<T>(
    cmd: string,
    args?: TauriInvokeArgs,
    options?: TauriInvokeOptions,
  ): Promise<T>;
  postMessage(message: unknown, command?: string): void;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    isTauri?: boolean;
  }
}

/**
 * Transforms a callback function to a string identifier that can be passed to the backend.
 * The backend uses the identifier to `eval()` the callback.
 *
 * @return A unique identifier associated with the callback function.
 *
 * @since 1.0.0
 */
export function transformCallback<T = unknown>(
  callback?: (response: T) => void,
  once = false,
): number {
  return window.__TAURI_INTERNALS__!.transformCallback(callback, once);
}

/**
 * Sends a message to the backend.
 * @example
 * ```typescript
 * import { invoke } from '@tauri-apps/api/core';
 * await invoke('login', { user: 'tauri', password: 'poiwe3h4r5ip3yrhtew9ty' });
 * ```
 *
 * @param cmd The command name.
 * @param args The optional arguments to pass to the command.
 * @param options The request options.
 * @return A promise resolving or rejecting to the backend response.
 *
 * @since 1.0.0
 */
export async function invoke<T>(
  cmd: string,
  args: TauriInvokeArgs = {},
  options?: TauriInvokeOptions,
): Promise<T> {
  return window.__TAURI_INTERNALS__!.invoke(cmd, args, options);
}
