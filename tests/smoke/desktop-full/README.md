# Desktop full-app smoke harness

Run the built Windows desktop app end-to-end against the local fixture:
Tests run against the **built release exe** (`apps/desktop/src-tauri/target/release/locallab-desktop.exe`) through WebView2's remote-debugging CDP endpoint. Playwright attaches to the real app; there is no browser stand-in for the native bridge.

```powershell
pnpm desktop:build   # apps/desktop/src-tauri/target/release/locallab-desktop.exe
pnpm test:desktop-ui
```

`pnpm test:desktop-ui` (`playwright test --config tests/smoke/desktop-full/playwright.config.ts`) runs one sequential test that: deletes `%APPDATA%\app.locallab.desktop` and `%LOCALAPPDATA%\app.locallab.desktop`, launches the release exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, attaches Playwright over CDP to the app's own WebView2 (`http://tauri.localhost/...`), completes onboarding with "Continue without a model", saves an OpenAI-compatible provider ("Desktop fixture" → `http://127.0.0.1:4599/v1`, model `desktop-smoke`), uses it, sends a chat message, and asserts the streamed reply. It then kills and relaunches the app **without** clearing data: the transcript reopens and a second message gets its distinct fixture reply without re-entering the API key — proof the provider list, chat persistence, and the keyring-held credential survived a restart. The test fails if the webview reports any uncaught page error and always leaves a full-page screenshot in the report dir.

JSON report: `tmp/desktop-smoke-results/report.json` (override dir with `LOCALLAB_DESKTOP_SMOKE_RESULTS`). The exe path can be overridden with `LOCALLAB_DESKTOP_EXE`.

## What this is

This is **fixture** evidence. The chat answers come from the loopback SSE fixture in `app.ts` (port 4599, CORS + OPTIONS, 401 without an `Authorization` header); it does not contact any vendor backend, and the harness does not exercise WebView2 navigation security or cross-platform shells.

## Deferred proof

- macOS/Linux desktop builds (`pnpm desktop:build` is Windows-only here); no Mac/Linux hosts on this machine.
- The export write itself: the UI provably raises the native Win32 save dialog (class #32770, detected and dismissed by `save-dialog.ps1`), but CDP cannot drive that dialog; the write path is covered by the `files_save` cargo tests instead. Import is fully automated end-to-end (file chooser fed a ZIP built by the app's own exporter, verified in bridge-owned SQLite).
- Live vendor backends (OpenAI-compatible cloud endpoints, keys) — the fixture only proves the app's request/credential/streaming plumbing reaches a spec-compliant endpoint.

**Current result:** 2026-10-19: `1 passed (35.2s)` covering import/export against the release build; the same flow earlier passed (`47.6s`/`47.4s`) against the release and per-user silent-installed exes. Cross-checked from outside the harness after the green run: the Windows Credential Manager holds `locallab:mobile-provider-headers:secret:sec_*` entries under `com.locallab.provider-secrets`; the roaming SQLite file holds both chat exchanges with two `completed` runs plus the imported `Imported smoke transcript` conversation.
