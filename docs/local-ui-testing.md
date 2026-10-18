# Test LocalLab locally

The Expo app's shared screens run on Windows through React Native Web. This lets us exercise the rendered app, SQLite persistence, file handling and provider requests before making another iPhone build. [Expo web support](https://docs.expo.dev/workflow/web/)

## Open the preview with your local server

Keep your llama.cpp server running. From this repository's root:

```powershell
& ./tools/start-local-preview.ps1 -ProviderOrigin http://127.0.0.1:35961
```

Open <http://localhost:8081>. The helper reuses a matching server, or starts a hidden server with source watching. It prints the actual `ServerProcessId` and a fresh log directory under ignored `tmp/local-preview/`. Use `-Restart` to reload Metro configuration or change the allowed provider origin; it only stops a verified Expo process belonging to this workspace. A readiness timeout does not mean the process stopped: inspect the printed logs before starting another copy.

The preview relays requests to the explicitly configured provider origin. This handles the running llama.cpp server's CORS restriction without changing its process or disabling browser security. The relay rejects other destinations and redirects, preserves streaming and cancellation, and forwards configured provider headers.

In **Providers**, choose **compatible**, then enter:

| Field                 | Value                       |
| --------------------- | --------------------------- |
| Provider name         | OxCoder · llama.cpp         |
| Provider endpoint URL | `http://127.0.0.1:35961/v1` |
| Exact chat model ID   | `local-coder`               |

Authorize the local HTTP origin, press **Test connection**, then **Save and use provider**. In **Settings → Model**, set the context window to **16384** and maximum output tokens to **2048**.

The loaded OxCoder template defaults to thinking and sometimes spends its whole output budget in repetitive reasoning. Its actual `/props` template recognizes `<|think_off|>`. For brief coding replies, set the model's **System prompt** to:

```text
<|think_off|>
You are a helpful coding assistant. Give clear, concise answers and working code when asked.
```

This flag is specific to the currently loaded template. Remove it if you want its thinking mode. LocalLab now reports an exhausted output budget separately from a finished answer. Reloading during generation preserves saved partial output and restores a usable chat.

The dedicated preview profile is already configured for this server with a 16384-token context, 2048-token output limit and the coding prompt above. An actual Python response survived reload. To reopen that Chrome app window:

```powershell
& ./tools/open-local-preview.ps1
```

Its own profile under `tmp/locallab-preview-profile/` retains chats and settings. Opening the URL in a different browser profile uses that profile's separate local data.

## Rendered interaction checks

The tests use installed Google Chrome and isolated browser contexts at desktop and iPhone-sized viewports. They click actual controls, choose real files and inspect downloads. The phone project is Chromium emulation; it is not physical iOS or Safari.

```powershell
& ./tools/run-pnpm.ps1 test:mobile-ui
```

By default, model-dependent scenarios are skipped. Provider fixture scenarios intercept their responses and make no paid API calls. To include actual requests to the running OxCoder server:

```powershell
$env:LOCALLAB_LIVE_API_BASE = 'http://127.0.0.1:35961/v1'
$env:LOCALLAB_LIVE_MODEL = 'local-coder'
$env:LOCALLAB_UI_RESULTS = 'tmp/full-local-ui-validation'
& ./tools/run-pnpm.ps1 test:mobile-ui
```

Use one test runner at a time: the local model has one generation slot. `LOCALLAB_UI_RESULTS` sets both artifact and JSON-report destinations; otherwise they go to `tmp/mobile-ui-results/`.

Coverage includes onboarding and live System themes, connection and model selection, linked connection edits/deletion, Library folders/search, Persona profiles and avatar cancellation/cleanup, Memory consent/manual facts/literal searches, settings scopes/reset/typing, attachment bytes and shortening notices, archive downloads/imports, composer keyboard modes and exact Markdown copying, real chat/Stop/retry/reload/new-chat, and interrupted generation recovery. Real context-policy checks compare Roll and Cut middle requests while preserving the original transcript. Live Memory checks edit a sourced fact and reopen its exact original message from another chat.

The [expanded workflow audit](implementation/evidence/app-workflow-audit-2026-09-27.md) distinguishes current scoped evidence, the consolidated run, labeled provider fixtures, and physical-device checks. Native abort compatibility has a separate check against the actual installed React Native and Expo implementations; browser passes alone cannot establish those native semantics.

## Platform limits

Browser SQLite uses Expo's WebAssembly/OPFS implementation. It currently permits one open LocalLab tab per browser profile; a second tab explains that the first must close before retrying. Another live owner's generation is never canceled by startup recovery. Expo describes SQLite web support as alpha. [SQLite web setup](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/#web-setup)

Managed browser files use IndexedDB. Provider keys stay in tab memory and need re-entry after reload; the native app uses private files and SecureStore. Original attachment bytes survive archive export/import. UTF-8 text extraction works; PDF/XLSX text extraction is explicitly unavailable, with a retained-original message and working removal action.

Semantic search without an embedding engine remains visibly unavailable. Native GGUF model import/download now ships a real iOS adapter (`modules/gguf/ios`, included since build 16), though physical-device inference speed and memory fit remain unmeasured. Browser testing cannot establish native GGUF/Apple inference, iOS keyboard/camera behavior, physical notch spacing or ad hoc reinstall behavior. The latest installable signed preview is **build 21** — see the [iPhone installation guide](iphone-installation.md); the physical phone pass remains pending.

Your server binds to this computer's loopback address. `127.0.0.1` on the iPhone means the iPhone itself. Phone access needs an appropriate LAN server binding/address or a private tunnel; the local browser relay is only for this computer's preview.
