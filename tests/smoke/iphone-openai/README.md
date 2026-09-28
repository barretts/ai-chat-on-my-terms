# iPhone OpenAI Responses smoke harness

Run the controlled network fixture and SQLite restart checks:

```powershell
pnpm --filter @locallab/models-imports exec vitest run --root C:/code/cht tests/smoke/iphone-openai
```

The fake Responses endpoint emits SSE through the production OpenAI adapter. Tests cover streamed answer and usage, persisted setup/conversation/transcript reopening after closing SQLite, early stop, and invalid-key redaction. This is **fixture** evidence; it does not contact OpenAI or prove iPhone networking.

## Live iPhone evidence still required

- Build and install on a physical iPhone from macOS/Xcode (`pnpm mobile:ios`).
- Record device model, iOS version, native build ID, configured Responses endpoint type (live vendor or compatible fixture), exact model ID, and whether a live test key was used. Never record the key itself.
- Send one known prompt with connectivity enabled, stop a second in-progress response, then force-quit/relaunch and reopen the conversation.
- Verify invalid-key and network failures leave the saved setup editable, keep the draft/history usable, and expose no secret in transcript or diagnostics.

**Current result:** controlled fixture tests only. Physical iPhone run and live vendor proof remain pending (T159A). The current Windows host cannot run Xcode or claim physical-device evidence.

The first-run route bootstraps the immutable core schema using equivalent inline DDL because Expo does not yet expose the migration runner's registered SQL source URLs as readable assets. It initializes chat-history tables and one constrained app settings table but does not write the shared `schema_migrations` ledger or apply optional migrations. Production schema-runner wiring and upgrade-path validation remain pending.
