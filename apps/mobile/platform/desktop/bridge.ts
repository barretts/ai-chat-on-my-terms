import { invoke } from "./tauri-invoke";

/** True when the app runs inside a Tauri v2 webview (the desktop shell). */
export function isDesktopBridge(): boolean {
  return (
    typeof window !== "undefined" && !!window.__TAURI_INTERNALS__?.postMessage
  );
}

/** Invokes one custom command exported by apps/desktop/src-tauri (desktop.rs). */
export function desktopInvoke<T>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>(cmd, args);
}
