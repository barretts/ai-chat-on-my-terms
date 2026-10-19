# AI Chat on My Terms

_My phone, my PC, my cloud — I refuse to pick one AI._

Start with the [current work index](plans/README.md) and the [remaining work ledger](plans/status/README.md). The original 202 task records are preserved: 118 unfinished cards remain active and 84 integrated units are [archived](archived/README.md). The [coverage ledger](plans/05-coverage.md) still maps all 231 feature records.

## The three routes

The product is defined by choice, not by one deployment target. Every route is real, and the user picks per device, per chat, per Persona:

| Route                         | What runs the model                                                                                                                                                        | Account or subscription         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **On the phone**              | On-device GGUF (`llama.rn`/llama.cpp) and Swift MLX, after the model is downloaded once                                                                                    | None, and free                  |
| **On your own hardware**      | The required macOS companion (remote models/voice, encrypted relay routes, USB, sync), plus LAN servers such as LM Studio and Ollama, discovered directly                  | None; your own machines         |
| **With your own paid access** | OpenAI Responses configured at first run, plus Anthropic, Gemini, Mistral and OpenRouter. Keys live in the phone's secure store and are sent only to the selected provider | Your own keys and your own bill |

Offline-first is the default posture, not a locked-down mode: install, load or download a model, and chat with no account and no hosted app service. Remote access, backup, accounts, hosted search and purchases are separate opt-in paths.

## Where the work stands

The first milestone is real offline GGUF chat and user-configured OpenAI remote chat on an iPhone, then a working full-feature iPhone build. Deep testing and internal release follow while iPad, Android and full desktop clients are built in parallel. The required Mac companion supports the phone's other remote/sync/voice routes.

The [feature inventory](docs/lm-mini-features.md) defines scope; it is a study of LM Mini, LM Mini Home and LM Mini Connect, and its "Pro" labels describe that product, not requirements for this one. Earlier research and design proposals are [archived](archived/README.md). `plans/` is the execution authority. The workspace holds the Expo mobile app, the desktop shell, the Rust companion, shared packages, runtime bridges and implementation evidence.

The [September 27 feature status](archived/docs/feature-status-2026-09-27.md) is a dated snapshot kept under `archived/`; for the newest installable app see the [iPhone installation guide](docs/iphone-installation.md) (latest build 21) and the [build records](docs/builds/ios-preview-21.md). The [phone models, offline voices, and OpenRouter guide](docs/phone-models-and-voices.md) covers the current local preview and PC model connection.

## Naming: the brand changed, the technical identifiers did not

The product is **AI Chat on My Terms**. It was previously called LocalLab, and the `locallab` strings still present in the tree are deliberate technical identifiers, not leftover naming. Renaming them is a compatibility change, not a cosmetic one:

- **`app.locallab.mobile` is permanent.** Apple's App Store Connect rule is that the bundle ID _cannot be changed after you upload your first build_, and build 21 is already signed and installed. Changing it would create a new App Store/TestFlight record with no ratings, no download history and no carried-over testers.
- **The EAS project identity is `barrett/locallab`** — `slug: locallab` in [apps/mobile/app.json](apps/mobile/app.json) carries it. Changing the slug strands the update channel and build history of an already-shipped build.
- **`@locallab/*` (pnpm), `locallab-*` (cargo crates) and `LOCALLAB_COMPANION_DATA_DIR` name packages, binaries and on-disk state.** Roughly 640 files reference `locallab`. The companion's macOS support directory (`~/Library/Application Support/LocalLab`, with `locallab.sqlite`) holds existing chats, routes and pairings; renaming it is a data migration, not a label change.
- **Some `locallab` strings are wire data.** The pairing HKDF labels (`locallab-pairing-*-v1`), `locallab-usb-v1`, the keyring service `com.locallab.provider-secrets` and the `locallab://` automation scheme are protocol and storage constants. Editing one side of them breaks pairing between a phone build and a companion build that is not rebuilt in lockstep, and changing the keyring service name orphans stored API keys unless a migration ships with it.

Display strings are the brand surface, and those were updated: the iOS app name and its usage prompts, the desktop product name and window title, the Rust crate descriptions, and the titles of the user-facing docs. The Mac-side companion labels itself **AI Chat Connect** in its tray menu, pairing prompts and health log. `plans/01-architecture.md` records the same rule for execution.

Rejected along the way, for the record: **LocalLab** (descriptive, not ownable, and sits in the LM Studio / LM Mini / LM Studio cluster this project studies), **Swallow/Eyas/Doocot**-style bird marks (the App Store listing needs the promise, not a nickname), and **`-LLM` or `AI`-inflected wordplay** such as SwaLLM, AIery or AIrone (unreadable aloud, and every `AI`-prefixed variant is already an AI company). "Here, there, anywhere" survives as marketing copy; the App Store name and subtitle fields are 30 characters each, so the listing carries `AI Chat on My Terms` plus a three-route subtitle, and this sentence carries the rest.

## Development checks

Use Node 22.13 or newer and pnpm 8.15.9. Run `pnpm typecheck`, `pnpm format:check`, and the task's focused test scripts. Chat composition checks run with `pnpm test:chat-composition`.

For the Windows sandbox with duplicate `PATH`/`Path` entries, use `& ./tools/run-pnpm.ps1 <arguments>`. The [runner repair evidence](archived/docs/implementation/evidence/runner-repair-2026-09-26.md) explains the bounded owner repair and tracked tsx temporary-directory fix.

The mobile app uses the [embedded migration runner](packages/schema/migrations/README.md). After registering a new immutable SQL migration, regenerate with `pnpm --filter @locallab/schema generate:embedded` and verify with `pnpm --filter @locallab/schema check:embedded`.

For a standalone installation on a registered iPhone, use the [iPhone installation guide](docs/iphone-installation.md) and the mobile EAS `preview` profile.

For local browser preview and rendered onboarding/chat interaction checks on Windows, use the [local UI testing guide](docs/local-ui-testing.md).

For the Windows desktop client (Tauri shell over the same web build, installers, smoke test and data locations), see the [desktop app guide](docs/desktop-app.md).
