# iPhone offline smoke harness

Run the deterministic managed-GGUF adapter fixture on any development host:

```powershell
pnpm --filter @locallab/models-imports exec vitest run --root C:/code/cht tests/smoke/iphone-offline
```

This proves that the app adapter accepts a managed `blob:<UUIDv7>` identity, emits bounded streaming events, releases its model lease, and rejects arbitrary file paths. The test injects a fake `llama.rn` context; it is fixture evidence, not an on-device inference result.

## Physical evidence still required

- Build and install the Expo development client on a physical iPhone from macOS/Xcode (`pnpm mobile:ios`).
- Import a licensed, redistributable tiny GGUF through the app model-import path. No GGUF asset is currently bundled in this workspace, so the model SHA-256, file size, license, and native build receipt are intentionally blank here.
- Record iPhone model, iOS version, native build ID, selected managed blob SHA-256, airplane-mode state, exact prompt, and whether the saved conversation reopens after force-quit/relaunch.
- Stop/cancel during generation and verify the app returns to a usable composer.

**Current result:** controlled adapter fixture only. Physical iPhone run, airplane-mode confirmation, model artifact/hash, and relaunch check are pending. Windows host cannot run the iOS native build.

The `/models` page currently has no GGUF file import action, and this workspace has no licensed GGUF asset. The offline route can run only a previously imported managed GGUF (`application/*gguf*` metadata); sourcing a redistributable model and completing the import UI remain prerequisites.

The first-run route bootstraps the immutable core schema using equivalent inline DDL because Expo does not yet expose the migration runner's registered SQL source URLs as readable assets. It initializes chat-history tables and one constrained app settings table but does not write the shared `schema_migrations` ledger or apply optional migrations. Production schema-runner wiring and upgrade-path validation remain pending.
