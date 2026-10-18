# LocalLab

Start with the [current work index](plans/README.md) and [remaining work ledger](plans/status/README.md). The original 202 task records are preserved: 118 unfinished cards remain active and 84 integrated units are [archived](archived/README.md). The [coverage ledger](plans/05-coverage.md) still maps all 231 feature records.

The first milestone is real offline GGUF chat and user-configured OpenAI remote chat on an iPhone, then a working full-feature iPhone build. Deep testing and internal release follow while iPad, Android and full desktop clients are built in parallel. The required Mac companion supports the phone's other remote/sync/voice routes.

The [feature inventory](docs/lm-mini-features.md) defines scope. Earlier research and design proposals are [archived](archived/README.md). `plans/` is the execution authority. The workspace includes the Expo mobile app, shared packages, runtime bridges, and implementation evidence.

The [September 27 feature status](archived/docs/feature-status-2026-09-27.md) is a dated snapshot kept under `archived/`; for the newest installable app see the [iPhone installation guide](docs/iphone-installation.md) (latest build 21) and the [build records](docs/builds/). The [phone models, offline voices, and OpenRouter guide](docs/phone-models-and-voices.md) includes the current local preview and PC model connection.

## Development checks

Use Node 22.13 or newer and pnpm 8.15.9. Run `pnpm typecheck`, `pnpm format:check`, and the task's focused test scripts. Chat composition checks run with `pnpm test:chat-composition`.

For the Windows sandbox with duplicate `PATH`/`Path` entries, use `& ./tools/run-pnpm.ps1 <arguments>`. The [runner repair evidence](archived/docs/implementation/evidence/runner-repair-2026-09-26.md) explains the bounded owner repair and tracked tsx temporary-directory fix.

The mobile app uses the [embedded migration runner](packages/schema/migrations/README.md). After registering a new immutable SQL migration, regenerate with `pnpm --filter @locallab/schema generate:embedded` and verify with `pnpm --filter @locallab/schema check:embedded`.

For a standalone installation on a registered iPhone, use the [iPhone installation guide](docs/iphone-installation.md) and the mobile EAS `preview` profile.

For local browser preview and rendered onboarding/chat interaction checks on Windows, use the [local UI testing guide](docs/local-ui-testing.md).
