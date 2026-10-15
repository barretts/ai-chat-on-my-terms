/** Optional, opt-in diagnostics for support submissions (AC-06). The
 * summary is fixed-field counts/versions with sanitized codes — it can
 * never carry chat text, prompts or message contents, and it is only
 * appended when the user explicitly toggles it. */

export interface RedactedDiagnosticsInput {
  appVersion: string;
  platform: string;
  modelCount: number;
  conversationCount: number;
  lastErrorCode: string | null;
  memoryFreeMb: number | null;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,48}$/;

function safe(value: string, max: number, fallback: string): string {
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : fallback;
}

export function buildRedactedDiagnostics(
  input: RedactedDiagnosticsInput,
): string {
  const lastError =
    input.lastErrorCode === null || !SAFE_CODE.test(input.lastErrorCode)
      ? "none"
      : input.lastErrorCode;
  const lines = [
    "redacted-diagnostics v1",
    `app-version: ${safe(input.appVersion, 32, "unknown")}`,
    `platform: ${safe(input.platform, 32, "unknown")}`,
    `models-installed: ${Math.max(0, Math.trunc(input.modelCount))}`,
    `conversation-count: ${Math.max(0, Math.trunc(input.conversationCount))}`,
    `last-error-code: ${lastError}`,
    `free-memory-mb: ${
      input.memoryFreeMb === null
        ? "unknown"
        : Math.max(0, Math.trunc(input.memoryFreeMb))
    }`,
  ];
  return lines.join("\n");
}
