# Continuation progress

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../plans/POWERSHELL.md).

Prepared October 8, 2026. This is the durable resume pointer for Qwen.

## Current position

Completed through: C10 — integration checkpoint
Next: subsequent batch 1 (remaining voice) per TASK_QUEUE.md (arena stays held)
- Completed: C00 source/roadmap audit and handoff creation.
- First dependency: audited build-14 working tree.
- User decisions: full roadmap, iPhone first; automatic web on tool-capable models only; no planning fallback; iOS dictation before Whisper; prioritize voice and tools/MCP; Arena held.
- Global environment note: pnpm absent from PATH; existing local TypeScript and Vitest execute successfully.
- Application changes made by this handoff pass: none.

## Completed evidence

| Check                      | Result                                                 | Evidence level                                                |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Build-14 source comparison | 856/856 manifest entries match; zero differences/skips | Source identity                                               |
| Mobile TypeScript          | Exit 0                                                 | Static check                                                  |
| Composition                | 24 files, 206 tests passed                             | Local functional fixtures                                     |
| git diff --check           | Passed before handoff creation                         | Whitespace                                                    |
| Phone usability            | User says last phone deployment works well             | General user feedback; exact build/feature matrix unconfirmed |

## Per-task records

Append one concise record for each completed or blocked task:

### Cxx — title — date

- State: running / implemented / integration-passed / blocked / held.
- Changed paths:
- Delivered behavior and original feature IDs:
- Exact commands and results:
- Evidence artifact paths and evidence level:
- Native/live proof still pending:
- Defects or blockers:
- Contract/migration changes:
- Next ready task and why:
- Source ranges/context needed to resume:

### C01 — persistent automatic web policy — 2026-10-09

- State: implemented; native/device proof pending (panel UI cannot be exercised from Windows).
- Changed paths:
  - apps/mobile/composition/chat/web-research-settings.ts
  - apps/mobile/composition/chat/web-research.ts
  - apps/mobile/composition/chat/web-research-settings.test.mts
  - apps/mobile/composition/chat/web-research-intent.test.mts
  - apps/mobile/composition/chat/web-research-settings-panel.tsx
  - apps/mobile/composition/chat/screen.tsx
  - handoffs/qwen3.8-flash-next-2026-10-08/PROGRESS.md
- Delivered behavior and original feature IDs:
  - Persisted conversation-mode overrides (prior step): web_research_conversation_overrides table;
    readConversationOverride/saveConversationOverride/removeConversationOverride; app-wide
    mode/provider/credentialRef persistence preserved.
  - New pure per-turn resolver resolveWebResearchPolicy(options) -> { effectiveMode, automaticTools,
    intent }: effectiveMode = resolveEffectiveWebResearchMode(appWideMode, conversationOverride), so a
    missing override inherits the current app-wide default; off mode vetoes everything
    (automaticTools false, intent {search:false, fetchPages:false}) despite chips, capability or explicit
    wording; automaticTools requires effectiveMode auto AND actual selected-model capability
    capabilities.tools === "yes" (no/unknown keeps manual workflow); a per-turn off choice
    (searchOverride === false) or a direct offline/no-web instruction vetoes search and the
    automatic tool grant (automaticTools false, intent.search forced false) while an enabled
    page-fetch chip stays neutral — the policy delegates intent to the unchanged legacy
    resolveWebResearchIntent (its pinned search-only veto and link-reading behavior are shared
    by manual/auto); automatic-tool eligibility stays a separate field from manual research
    intent. User decision 2026-10-10: the per-turn veto covers automaticTools + search only.
  - web-research.ts: offline/no-web detection extracted from resolveWebResearchIntent into exported
    offlineInstructionRequested(text) (quoted/code text still stripped via actionableProse, so quoted
    examples never become offline instructions); detector covers lookup-style wordings such as
    "Do not look this up online/on the web/on the internet." via negation + look/fetch/open/read +
    this/that/it + optional "up" + optional "on [the]";
    intent options widened to `?: X | undefined` per the
    exactOptionalPropertyTypes convention (packages/parameters) to allow pass-through.
  - C01 wiring step: screen send-path now resolves the policy instead of the legacy intent
    resolver directly — after actual capabilities are known it calls
    resolveWebResearchPolicy({ appWideMode: runtime.webSettings.read().mode ?? "auto",
    conversationOverride: runtime.webSettings.readConversationOverride(runtime.conversationId),
    capabilities: providerCapabilities, text, searchEnabled: payload.searchEnabled,
    fetchPagesEnabled: payload.toolIds.includes(WEB_FETCH_TOOL),
    previousUserMessages }) and feeds policy.intent into the existing manual
    withWebResearch path (search/searchQuery/fetchPages, webEnabled); automaticTools is not yet
    consumed (C02). The composer payload (searchEnabled/toolIds) needed no change: the
    default-false search chip stays neutral, never a stored veto.
  - Panel controls: app-wide mode dropdown (Auto · with capable models / Manual · only when you
    ask / Off · never browse) saved through saveWebResearchConfiguration, which gained an optional
    mode (options.mode ?? previous.mode ?? "auto", so unrelated saves still preserve mode); a
    second "This chat" surface reads settings.readConversationOverride(conversationId) and applies
    Use app default / Auto / Manual / Off immediately via save/removeConversationOverride —
    changing it never issues a web request; the screen passes conversationId={runtime.conversationId}.
  - Requested extension mapped to TL-09/TL-11; original IDs unchanged.
- Exact commands and results:
  - `node node_modules/vitest/vitest.mjs run apps/mobile/composition/chat/web-research-settings.test.mts
    apps/mobile/composition/chat/web-research-intent.test.mts apps/mobile/composition/chat/web-research.test.mts`
    → Test Files 3 passed, Tests 44 passed (settings 12: 5 policy cases including the
    "Do not look this up online." phrase and the per-turn-off fetch-neutrality pin
    (searchOverride:false + fetchPagesEnabled + link text → intent.fetchPages true,
    automaticTools false); intent 11: auto-policy case loops four offline wordings including
    "Do not look this up on the web." and "Never look it up on the internet." and keeps
    quoted/code examples non-offline; web-research 21: legacy resolver pins unchanged).
  - `node node_modules/typescript/bin/tsc --noEmit -p apps/mobile` → exit 0.
  - Final C01 verification after panel/screen wiring (powershell.exe wrapper): the three suites
    plus apps/mobile/features/composer/advanced/composer.test.mts → Test Files 4 passed, Tests 49
    passed (composer 5 payload pins); tsc --noEmit -p apps/mobile → exit 0.
- Evidence artifact paths and evidence level: settings/intent/web-research test runs — local functional
  fixture proof.
- Native/live proof still pending: web settings panel (mode dropdown, per-chat override row) and
  send-path policy resolution are typechecked and unit-pinned at the pure/policy level but not yet
  exercised on a real phone; no autonomous tool loop until C02 consumes automaticTools.
- Defects or blockers: an earlier review fix had forced both intent fields false on per-turn
  off/offline wording; superseded by the user decision above (search + tool-grant veto only,
  fetch chip neutral) with pins updated. Separately, the offline detector had missed "Do not
  look this up online." — fixed with the regression pins above.
- Contract/migration changes: new web_research_conversation_overrides table (backward-compatible);
  exported pure resolver and offlineInstructionRequested added; resolveWebResearchIntent option types
  widened (source-compatible).
- Next ready task and why: C02 — autonomous web tools; C01 shipped the persisted mode/override,
  the capability gate (resolveWebResearchPolicy.automaticTools) and the send-path wiring C02
  builds on. Read handoffs/qwen3.8-flash-next-2026-10-08/tasks/C02-autonomous-web-tools.md first.
- Source ranges/context needed to resume (C02): apps/mobile/composition/chat/screen.tsx send path
  (policy resolution right after providerCapabilities ≈ line 1138, webEnabled/tool loop
  registration ≈ 1175-1250, withWebResearch ≈ 1273-1300); web-research-settings.ts
  resolveWebResearchPolicy/automaticTools; features/composer/advanced/composer.tsx (search chip
  neutral, payload unchanged); web-research-settings-panel.tsx (mode + override controls).

Do not log credentials, user messages, large response bodies or full command output.


## Completed: C02 — autonomous web tool loop (fixture proof; device proof pending)

- C02 depends on C01 and builds on its policy resolution.
- Files:
  - `apps/mobile/composition/chat/web-research-tools.ts` (new):
    `createWebResearchTools` exposes `web_search`/`web_fetch` as registered engine
    tools under a dedicated server id, reusing the `web-research.ts` client and
    SSRF-safe fetch. Per-turn caps (2 searches, 4 page reads, 800-char snippets,
    12,000-char page excerpts) return a bounded result instead of failing the loop,
    so the model answers with the evidence it has. Private-URL refusal is a
    recoverable structured failure; malformed arguments are rejected before any
    network access.
  - `apps/mobile/composition/chat/web-research-tool-sources.ts` (new): wraps the
    provider port to derive deduplicated `Source` events from validated web tool
    results — live and rebuilt from saved tool context on replay — preserving
    monotonic sequences and exactly one terminal event, so autonomous research
    cites through the same pipeline as the manual prepass and citations survive
    reopening.
  - `apps/mobile/composition/chat/screen.tsx`: policy resolves from cached settings
    reads before port creation; `toolsEnabled` now requires endpoint tool support
    AND (workspace tools OR autonomous web); per-turn registry registers web tools
    next to file tools; when the model is autonomous the manual prepass stands down
    (no duplicate search); system-prompt guidance tells the model to call the tools
    for current information and to answer without further searching once the
    budget is spent.
  - `tests/ui/autonomous-web-research-tools.spec.ts` (new): phone-width browser
    case.
- Decisions: budget exhaustion is a tool result, not an error (the loop survives);
  source events are derived at the provider boundary, not persisted ad hoc;
  capability gating happens at port creation, so a tool-less endpoint can never
  advertise web tools regardless of saved mode.
- Invariants:
  - A model that chooses no tools causes zero web requests; explicit chips and
    the offline veto keep working.
  - Tool exchanges and their sources replay through the normal event pipeline
    (`RunEventBatchSchema` accepts wrapped streams).
  - Canceling a live tool aborts the run without a partial tool message.
- Verification:
  - `apps/mobile/composition` 27 files / 232 tests EXIT 0 (13 new focused tests:
    caps, argument validation, SSRF refusal, failure shape, source
    dedup/replay/cancellation).
  - `packages/providers/compatible-local` + `packages/tools/engine`: 4 files /
    63 tests EXIT 0 (adapter and engine themselves unchanged).
  - `tsc --noEmit -p apps/mobile` EXIT 0.
  - Playwright desktop + phone: `autonomous-web-research-tools` 2 passed — tools
    advertised without search keywords, the model searched then read on its own,
    the search result replayed as a tool message, sources rendered as citations,
    the follow-up answered from context with zero new web requests, no runtime
    errors; `automatic-web-research` regression 2 passed.
- Still pending (native/device, Windows): real tool-capable model (NInfer) calling
  the tools on device; T128/T159 device evidence unchanged.


## Completed: C03 — shared audio/session foundation (fake-port proof; native proof pending)

- New package `@locallab/audio-session` at `packages/audio/session`:
  - `src/ports.ts`: `SpeechInputPort` (availability, locales, listen with
    partial/final transcript, AbortSignal) and `SpeechOutputPort`
    (availability, isSpeaking, speak, idempotent stop, dispose) with typed
    `AudioResult`/`AudioPortCode`/`AudioAvailability` states.
  - `src/coordinator.ts`: `AudioSessionCoordinator` — phases
    idle/listening/transcribing/generating/speaking; generation-based
    ownership so canceled or superseded operations cannot mutate state a newer
    operation owns; `beginGenerating`/`endGenerating`; `dispose` refuses
    admission while draining and awaits every owned operation's raw
    settlement promise before disposing the ports (canceled durable work does
    not mean native resources were released).
  - `test/session.test.ts` (8 tests): capture closed before playback,
    owned playback stopped before capture, superseded partials dropped (no
    self-transcription path), repeated stop safe and capture never
    auto-restarts, cancellation affects only owned work, documented phase
    transitions, playback failure settles idle, drain-before-dispose with
    admission refused meanwhile.
- App adapter `apps/mobile/composition/audio/offline-speech-output.ts`:
  `createOfflineSpeechOutput(OfflineSpeech)` maps `speak` (resolves when
  playback finishes), `stop`, `isSpeaking` (`phase === "playing"`) and
  availability (installed models, non-error phase) without touching pack
  storage, voice selection, rates, Persona preferences or Stop behavior;
  3 regression tests prove voice/rate/Persona state survives.
- Wiring: root `test:audio-session` script and root `typecheck` filter include
  the package; `apps/mobile/package.json` dependency added; because pnpm is
  unavailable the workspace link was created as a junction at
  `apps/mobile/node_modules/@locallab/audio-session` (recreate with pnpm
  install when available).
- Verification: package suite 8 passed EXIT 0; `tsc -p packages/audio/session`
  EXIT 0; composition suite 29 files / 243 tests EXIT 0 (includes adapter);
  `tsc -p apps/mobile` EXIT 0; personas-library 5/5 via the node test runner
  (vitest cannot collect that package's node:test style — pre-existing).
- Pending native proof: real microphone capture/playback exclusivity on
  device; C04 wires the iOS dictation input port. No hardware routing or
  lock-screen behavior is claimed from fixtures.

## Completed: C04 — iOS system speech recognition (fixture proof; native/device proof pending)

- New Expo module package `@locallab/speech-system` at `packages/speech-system`
  (deviation from the card path `modules/speech-system/ios`: the repo's existing
  Expo-module scaffold precedent `@locallab/compat-apple-ml` lives under
  `packages/`, and workspace glob/autolink wiring only covers `packages/*`;
  same scaffold shape: `expo-module.config.json`, `ios/SpeechSystem.podspec`,
  `ios/SpeechSystemModule.swift`, `src/index.ts` + `src/expo.ts`).
- Swift bridge (`SpeechSystemModule`): AVAudioEngine tap + SFSpeechRecognizer;
  `getAvailability` (permission merged from SFSpeechRecognizer auth and
  `AVAudioApplication.recordPermission`, supported-locale list,
  `supportsOnDeviceRecognition`); `requestPermission` only callable as an
  explicit action; `startListening` refuses `ON_DEVICE_UNAVAILABLE` before any
  capture when `onDeviceOnly`; prefers on-device automatically; emits
  session-scoped `partial` events keyed by `requestId`; `stopListening`
  finalizes; `cancelListening` discards; teardown removes tap, stops engine,
  deactivates the audio session.
- TS facade `createSpeechSystemInput(native, { requireOnDevice })` implements
  the C03 `SpeechInputPort` plus `cancel()` (discard) and `operationInfo()`
  (locale + onDevice disclosure set before any partial reaches the caller):
  permission requested only on the recognition action; denial/unsupported
  locale/offline-only refusal return typed port failures without starting
  capture; stale/foreign/finished-request callbacks dropped; listeners removed
  on completion; pre-empting capture cancels the older one.
- C03 ports: `SpeechOutputPort.getAvailability` added (fake/adapter already
  provided it); `speak(text, options)` options made required at call sites.
- Mobile registration: `@locallab/speech-system` dependency + junction in
  `apps/mobile/node_modules` (pnpm absent; recreate via pnpm install),
  `NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription` in
  `apps/mobile/app.json` `ios.infoPlist`; root `typecheck` filter and
  `test:speech-system` script updated.
- Scope kept to dictation: system TTS (AVSpeechSynthesizer half of T072) is
  untouched by design; playback stays on the existing neural voices through
  the C03 output adapter.
- Verification: `packages/speech-system` 10 fixture tests EXIT 0 (denied
  permission, not-determined prompt, unsupported locale, offline-only refusal,
  network disclosure before text, partial/final order, stop vs cancel,
  stale-callback rejection, pre-empt cleanup, dispose cleanup);
  `tsc -p packages/speech-system` / `packages/audio/session` / `apps/mobile`
  EXIT 0; composition 29 files/243 tests + audio-session 8 tests EXIT 0.
- Pending (explicit): no macOS toolchain on this workstation — Swift module
  compile, Expo autolink/pod install, and the physical phone check (mic
  permission prompt, language choice, recognized text, capture cleanup) are
  NOT done; no offline-recognition claim beyond the `supportsOnDeviceRecognition`
  gate. C05 app integration must not be marked done from these facade tests.


## Completed: C05 — dictation composer, autosend, voice preferences (2026-10-10)

- Branch: main. Plan: docs/superpowers/plans/2026-10-07-iphone-native-dictation.md
  (implemented at cards/C05's `modules/` paths but under `packages/` as in C04;
  the dictation controller lives in composition/chat, not composer/advanced).
- Composition files: apps/mobile/composition/audio/dictation-input.ts
  (createSpeechSystemInput(speechSystemNative)), dictation-input.web.ts
  (honest unavailable stub), composition/chat/dictation.ts
  (DictationPreferences {locale, autosend}, SQLiteDictationPreferenceStore — new
  dictation_preferences singleton table, DictationController over
  AudioSessionCoordinator + the offline-speech adapter), dictation.test.mts
  (8 tests: stop finalizes once, cancel discards, newer start pre-empts,
  partials survive via the wrapped handler, SQLite roundtrip, defaults).
- UI: features/composer/advanced/index.ts adds DictationOutcome + mergeDictationText;
  composer.tsx grows onDictate/onDictateStop/onDictateCancel/dictationAutosend/
  dictationUnavailableReason props — Dictate chip with Stop/Cancel chips and a live
  partial preview, autosend posts the merged text exactly once, and the reason
  text replaces the control where dictation is impossible.
  features/speech/screen.tsx renders the dictation card (status text, recognition
  language dropdown, autosend switch) on both phone and desktop layouts.
  composition/chat/screen.tsx loads availability/locales/preferences, saves prefs
  through the store, cancels capture on backgrounding, disposes on unmount, and
  gates the composer: the chip stays for "ready"/"permission"/"unknown" (taps get
  honest errors), only "unavailable" swaps in the reason sentence.
- apps/mobile/tsconfig.json: lib ES2024 (Promise.withResolvers in compiled
  speech-system sources).
- Decisions: preferences ride their own table (no composer_preferences migration);
  Stop finalizes through the facade (abort → final outcome), Cancel discards via
  the native cancel; controller created in useMemo, dispose on screen unmount.
- Verification: vitest (speech-system, audio/session, composition, composer/advanced)
  32 files 267 tests EXIT 0; tsc -p apps/mobile, packages/speech-system and
  packages/audio/session all EXIT 0; Playwright tests/ui/dictation-capability.spec.ts
  desktop+phone PASS (no fake record control on browsers, honest capability note in
  composer and Voices card, autosend switch present). Gotcha: the `expo start
  --no-dev` web server caches the production bundle — restart it after source edits.
- Still pending for C05: recognition, Stop/Cancel fit, autosend send, and
  interruption behavior on a physical iPhone; Swift compile via prebuild/Xcode
  (carried from C04).


## Completed: C06 — general tool settings + current-time built-in (2026-10-10)

- Branch: main. Cards: tasks/C06-tool-settings.md, plans/tasks/P06/T066.md.
- New workspace package `packages/tools/builtins` (`@locallab/tools-builtins`):
  `createCurrentTimeTool({clock?, timeZone?, locale?})` — canonical name
  `current_time`, server id `…0088`, parameters {} only, result
  `{iso, local, timeZone, locale}` via Intl; invalid timeZone → honest
  malformed; aborted signal → canceled. `CURRENT_TIME_TOOL_ALIASES`
  (get_current_time, current_date) are display/identity-matching only: the
  registry identity (`^[A-Za-z_]…` name) NEVER changes on rename — friendly
  labels live only in settings JSON, invocations/history keep the stable name.
- `apps/mobile/features/tool-settings/settings.ts`: TOOL_SETTINGS_CATALOG
  (web_search, web_fetch, workspace_list/read/write_file, current_time),
  DEFAULT_TOOL_GLOBAL_SETTINGS (enabled, roundLimit 6), SQLiteToolSettingsStore
  (tables tool_settings singleton + tool_settings_conversation; validation:
  ≤8192B JSON, catalog keys only, label regex, roundLimit null|1..50),
  resolveToolPolicy (participant ?? chat ?? global; capabilities.tools !== "yes"
  ⇒ engaged false; per-tool conversation overrides global; unset inherits true).
  `ToolServerConfiguration {id,label,url,authSecretRef?,enabled}` exported as the
  common server-configuration seam for C07–C09 (host-scoped SecretStore refs
  only — no raw headers/keys in settings rows).
- `features/tool-settings/screen.tsx` ToolSettingsPanel: app-wide master,
  per-chat Inherit/On/Off, round policy 3/6/12/Unlimited (null removes only the
  round cap; deadline/token/size limits stay — engine unchanged), per-tool
  enable + rename with the honest "renaming changes only what you see" note,
  effective-status line. All saves SQLite-only; zero network I/O.
- `composition/chat/screen.tsx`: runtime.toolSettings store; per-turn
  resolveToolPolicy after provider capabilities; fileTools/webTools filtered
  per-tool; current_time appended when toolsEnabled; wrap policy now
  `globalEnabled: toolPolicy.engaged, roundLimit: toolPolicy.roundLimit`.
  Chat nav gains "Tools" (navigation.ts label, both nav arrays, simple-mode
  allowlists, wrench icon, panel branch BEFORE the ChatPanels catch-all).
- Root package.json: test:tools-builtins + tools-builtins in the typecheck
  filter list. Junctions: packages/tools/builtins/node_modules/{@locallab/
  contracts,@locallab/tools-engine,typescript,vitest}; apps/mobile/node_modules/
  @locallab/tools-builtins.
- Verification (Windows): vitest (builtins, tools/engine, tool-settings,
  composition, composer/advanced, speech-system, audio/session) 35 files
  311 tests EXIT 0; tsc -p apps/mobile and packages/tools/builtins EXIT 0;
  Playwright tests/ui/tool-settings-panel.spec.ts desktop+phone PASS (panel
  opens from both navs, six tools listed incl. Current time, per-tool disable
  persists across close/reopen, master-off greys rows "off everywhere", ZERO
  external network requests via route spy, no page errors);
  autonomous-web-research-tools + dictation-capability still green both projects.
- Pending for C06: physical iPhone/device pass (Windows-only verification so
  far); native SQLite behavior identical to fixture stores but unproven on device.

## Completed: C07 — HTTP MCP server connection (2026-10-10)

- Branch: main. Cards: tasks/C07-http-mcp.md, plans/tasks/P06/T064.md.
- New package `packages/tools/mcp-http` (`@locallab/tools-mcp-http`,
  builtins-style layout; deps contracts/tools-engine/network-http; junctions
  inside + `apps/mobile/node_modules/@locallab/tools-mcp-http`): JSON-RPC
  2.0 streamable-HTTP MCP client `McpHttpClient(config, {fetch?})` with
  `initialize`/`discoverTools` (returns `McpDiscovery {tools, errors}` —
  invalid-name/invalid-schema tools are rejected per-tool, never silently),
  `callTool`, `dispose`; legacy SSE endpoint negotiation fallback; typed
  errors `McpOfflineError/McpAuthError/McpTimeoutError/McpProtocolError/
  McpUnsupportedTransportError` + `mcpErrorResult` → PortResult-compatible
  codes offline/auth/timeout/protocol/unsupported/canceled;
  `createMcpTools(client, {serverId?, labels?})` maps tools to engine
  `RegisteredTool` — remote ORIGINAL name is the identity, labels
  display-only, schema-lite `parseInput`, `isError` → ok:false, success
  value `{text, structuredContent?}`.
- Redirect safety (headline acceptance): every fetch uses
  `redirect:"manual"`; a same-origin redirect chain (≤5 hops) keeps the
  configured headers; any cross-origin redirect is refused with
  `McpProtocolError` — fixture B (foreign origin) observed ZERO requests,
  proving no secret-header leakage.
- `McpServerConfig.headers` carries resolved VALUES only; the package never
  sees SecretStore refs. App-side `features/tool-settings/mcp-servers.ts`:
  SQLite table `mcp_servers` (≤8KiB JSON, label/name regexes, `sec_`-shaped
  authRef, http/https-only URLs, user:pass@ rejected with "Put credentials
  in the key field…"), `resolveMcpHeaders` (SecretStore origin match —
  "different server" refusal), `collectMcpTools(store, secrets, signal)` →
  per-turn tools from ENABLED servers × ENABLED discovered tools only,
  honest `McpServerOutcome`s on failure (enablement untouched, no silent
  replacement), plus `finalize()` that disposes live clients at end of the
  turn (execute closures need the client alive during the run).
- UI: `McpServersSection` in the Tools panel (`mcp-panel.tsx`): add
  labeled URL + optional Bearer key (stored via `secrets.put(origin,
  "authorization", …)`), servers start DISABLED, "Check server" lists
  discoveries with every per-tool switch default OFF, honest offline/auth/
  timeout/protocol/unsupported notice lines, remove deletes row + secret.
  Panel receives `servers`/`secrets` from the chat screen;
  `mcpServers: SQLiteMcpServerStore` added to ChatRuntime; send flow calls
  `collectMcpTools` with a 15s deadline controller and finalizes in the
  outer send finally.
- Fixture server (test/mcp-http.test.ts + mcp-servers.test.mts): node:http
  on 127.0.0.1:0 — streamable JSON, SSE-framed responses, legacy SSE
  endpoint fallback, 401→auth, closed-port (39111/39112)→offline,
  slow-call + abort→canceled, invalid-name tool excluded, redirect pair
  A→B leak test, disabled server ⇒ zero fixture requests.
- Root package.json: `test:tools-mcp-http` script +
  `--filter @locallab/tools-mcp-http` added to typecheck list.
- Verification (Windows): vitest 8 paths (tool-settings, mcp-http,
  builtins, engine, composition, composer/advanced, speech-system,
  audio/session) 37 files 330 tests EXIT 0 (19 new MCP tests); tsc
  -p packages/tools/mcp-http and apps/mobile EXIT 0; Playwright
  tool-settings-panel (incl. new MCP steps: add → switch visible+unchecked,
  Check server → "Could not reach MCP server" notice, remove → row gone,
  still ZERO non-localhost requests, no page errors) desktop+phone PASS;
  autonomous-web-research-tools + dictation-capability still green.
- Pending for C07: physical iPhone pass; live third-party MCP server proof
  is separate from fixture success (card rule); LAN MCP through the
  existing local-HTTP authorization prompt is exercised only implicitly.

## Completed: C08 — configured SearXNG (2026-10-10)

- New package `@locallab/tools-searxng` at `packages/tools/searxng` (card's
  `packages/search/searxng` path does not exist; tools/ follows the C07
  packages/tools/* precedent). Exports: `SearxngClient(config, {fetch?})`
  (normalized query, `format=json`, optional `language`/`categories`, Bearer
  from config, per-call AbortSignal, bounded 4 MiB body + 15 s default
  timeout), `SearxngResult` (title ≤200 markup-stripped, url, text, engine,
  score), `SearxngSearchOutcome {results, dropped}`, 8-code `SearxngError`
  (offline/auth/timeout/canceled/ratelimited/malformed/unsupported/
  malformed-config) + `searxngErrorResult` (isError + code, no credentials),
  and the single canonicalizer `normalizeSearxngBaseUrl` (absolute http(s),
  no userinfo; origin + path prefix, trailing slash dropped). JSON is never
  assumed: text/html → unsupported ("enable format=json"), non-JSON →
  malformed, 401/403 → auth, 429 → ratelimited, closed port → offline,
  redirects manual/same-origin ≤5 (cross-origin → unsupported). `results: []`
  is a success with zero results. 27 package tests against real
  `node:http` fixture servers on 127.0.0.1:0 — no global fetch stubbing.
- App seam: `WebResearchSettings.provider` gained `"searxng"` plus a
  required `endpoint` field (contract tests updated, not re-pinned).
  `ensureSchema` migrates the legacy `CHECK (provider IN ('public','brave'))`
  table via copy→`web_research_settings_v2`→rename (SQLite cannot relax a
  CHECK in place) and adds the `endpoint` column; old public/brave rows
  survive reopen (pinned). `saveWebResearchConfiguration` gained
  `endpoint?: string | null`: the address is canonicalized before anything
  is written (invalid URL → honest throw, nothing persisted, pinned), the
  optional access key is stored in the SecretStore under the endpoint's
  OWN origin as an `authorization: Bearer …` header (Brave's key stays
  under the Brave origin; refs are retained across provider switches and
  the adapter resolves headers per search against the endpoint origin, so
  a foreign ref yields NO headers — pinned).
- `apps/mobile/composition/chat/searxng-web-search.ts`:
  `createSearxngResearchClient` adapts the package to `WebResearchClientLike`
  (`search`/`fetchPage`); construction without a saved address throws before
  any request; result URLs pass the existing `publicPageUrl` SSRF gate
  (private/link-local results dropped, dedup, 10 sources); every failure
  maps to the existing `WebResearchError` reasons with no fallback — a
  test client whose public search throws proves the public client is never
  used as fallback; `fetchPage` stays on the credential-free public client.
- Transport decision: SearXNG search calls go through `providerFetch`
  (platform/provider-fetch): native passes through directly; the web dev
  bundle relays CORS-blocked configured origins via `/_locallab/provider`
  only for explicitly configured provider origins on localhost preview —
  the card's "explicit local-HTTP authorization where relevant". Brave
  keeps its origin-locked `braveSearchFetch` unchanged.
- Panel (web-research-settings-panel.tsx): "SearXNG server" provider option;
  required address field (Save disabled until filled), optional secureTextEntry
  access key (re-entry = replace, blank = keep, "Key saved." note,
  "Remove saved SearXNG key"), honest helper that the instance must enable
  format=json.
- Root package.json: `test:tools-searxng` script + typecheck filter;
  junctions created for the package deps and for
  `apps/mobile/node_modules/@locallab/tools-searxng` (pnpm absent).
- Verification: sweep 39 files / 367 tests EXIT 0 (incl. package 27, new
  `searxng-web-search.test.mts` 6, settings 16 incl. 4 new migration/endpoint
  tests, brave 9 contract-updated); `tsc --noEmit` apps/mobile,
  packages/tools/searxng, packages/tools/mcp-http all 0; Playwright
  web-research-settings (2 incl. NEW SearXNG smoke: save with zero probes
  to the configured origin, address survives reload, key never in
  localStorage), tool-settings-panel, dictation-capability,
  autonomous-web-research-tools — 10 passed desktop+phone on a fresh
  `--no-dev` bundle.
- Pending: proof against a live real SearXNG instance (fixture success is
  separate — card rule); physical iPhone pass.

## Completed: C09 — LM Studio integrated MCP (2026-10-10)

- New package `@locallab/tools-mcp-lmstudio` at `packages/tools/mcp-lmstudio`
  (no runtime deps): canonicalizes host integration names (`playwright` →
  `mcp/playwright`; URLs/traversal rejected — remote URLs stay in the C07
  HTTP MCP path), collects deduped enabled references in config order, pins
  `supportsLmStudioIntegratedMcp` true for lmstudio only (ollama/compatible/
  jan/omlx/unsloth/openai pinned false), and translates missing/blocked/
  unavailable plugin errors into honest explanations naming the reference
  and the mcp.json recovery (LM Studio docs verified: native v1
  `integrations: ["mcp/<name>"]`, gates "Allow calling servers from
  mcp.json").
- `packages/providers/lmstudio`: `LMStudioOptions.integrations` is a per-run
  resolver threaded into `nativeBody` only — compatible fallback bodies
  structurally never carry the field; `RunFailed` messages pass through
  `failureMessage` translation (unrelated errors untouched). Continuation,
  cancellation and bearer behavior unchanged. 6 tests incl: references sent
  to native requests only, resolver re-read per run, compatible body has no
  `integrations`, continuation survives with integrations, missing plugin →
  friendly RunFailed.
- App seam: `SQLiteLmStudioIntegrationStore`
  (`apps/mobile/features/tool-settings/lmstudio-integrations.ts`) stores
  canonical name + friendly label + enable toggle; added rows start
  disabled; renaming changes only the label — id and reference are stable
  (pinned). `LmStudioIntegrationsSection` (`lmstudio-panel.tsx`) added to
  the Tools settings panel: name/label inputs, per-row rename (blur-saved),
  enable switch, remove, helper text ("LM Studio runs these servers… this
  phone only stores the names… LM Studio only").
- Wiring: `ChatProviderFactoryOptions.lmStudioIntegrations` consulted only
  when `supportsLmStudioIntegratedMcp(r.kind)`; passed at the chat send path
  only (capability probes/setup tests never trigger integrations); per-run
  closure keeps providerCache reuse honest. Pinned in providers.test.mts:
  lmstudio native body carries `integrations: ["mcp/playwright"]` (disabled
  row excluded), ollama bodies never contain the field even if the option is
  passed.
- Verification: package 7 tests + provider 6 tests EXIT 0; sweep 42 files /
  385 tests EXIT 0 (incl. store 3, providers.test.mts 19); tsc EXIT 0 for
  apps/mobile, provider-lmstudio, tools-mcp-lmstudio; Playwright 10 passed
  desktop+phone on a fresh `--no-dev` bundle — tool-settings-panel now
  covers LM Studio add (disabled by default), enable, rename with the
  reference still `mcp/playwright` in helper/remove labels, reopen
  persistence (desktop), remove, zero non-localhost requests, zero page
  errors.
- Pending: real LM Studio host proof (T159G later evidence; fixtures are
  separate per card rule); physical iPhone pass.

## Completed: C10 — integration checkpoint (2026-10-10)

- Runner-classified full local sweep (all test files enumerated and split by
  runner: 84 vitest, 39 node:test, 3 `.cjs`): vitest 647/650 with the only
  3 failures + 1 broken-import file pre-existing and untouched by the queue
  (see findings); node:test batch 196/197; local-preview proxy `.cjs` suites
  4/4 EXIT 0. Every one of the 59 typecheck projects ran individually
  (`tsc --noEmit -p`): zero failures, including apps/mobile and all
  C01-C09 packages.
- Full `tests/ui` Playwright (25 specs × desktop+phone on a fresh `--no-dev`
  bundle): after one contract update, 26 passed, 16 skipped (real-model/
  device-gated), 64 failed — all classified, none caused by C01-C09 behavior:
  - Contract update (intended C01 policy): `tests/ui/workspace-files.spec.ts`
    now expects automatic web tools (`web_search`, `web_fetch`,
    `current_time`) alongside workspace tools on a default-auto tool-capable
    request — this is the C01 automatic web policy working as designed
    (`resolveWebResearchPolicy`: auto + capabilities.tools=yes). Re-run after
    the update: 4/4 passed desktop+phone.
  - Pre-existing build-14 spec drift (64 failures): specs written against the
    pre-build-14 fresh-profile flow (buttons "Choose power user setup",
    headings "LocalLab Chat"/"Your conversation"/"Connections") land in the
    build-14 first-run chat shell ("Offline chat", "Make room for a good
    idea"); fixtures never reach the model path, e.g. web-research.spec.ts
    captured a null model request. Affected specs: attachments-archives,
    attachments-boundaries, collapsible-layout, composer-interactions,
    full-response-errors, library-connections, onboarding,
    openrouter-provider, persona-context, persona-memory-boundaries,
    search-panel, supporting-panels, transcript-scroll, web-research. Those
    spec files and the onboarding/first-run sources are unchanged at HEAD;
    no C01-C09 diff touches onboarding or the first-run shell (verified via
    per-file git diff).
- Checkpoint behaviors proven in current suites (fixture evidence): exact
  native tool definitions on model requests (workspace-files pins the full
  list; C02 loop spec pins search→read→cite with source records), per-request
  budgets/max_tokens, replay/continuation and selected-binding regeneration,
  stateful MCP tool list, LM Studio integration re-read per run, citations
  and durable tool records surviving reopen (tool-source + archive round
  trips), Stop/cancellation with one terminal event, dictation through the
  common audio coordinator with TTS intact, and no-secret/localhost-only UI
  pins.
- Checkpoint findings — pre-existing failures at the checkpoint, outside the
  queue diff; owning cards stay open and are NOT cleared:
  1. `tests/smoke/iphone-openai/responses-fixture.test.mts` secret-safety
     case fails: `packages/providers/openai-first-run/src/index.ts` composes
     the saved-key failure message with `errorDetails(cause)` and the
     controlled fixture proves saved-key text reaches
     `RunFailed.error.message`. Real provider defect; openai-first-run is
     not in this queue's scope, so it is reopened on its owning card, not
     patched here.
  2. `tests/smoke/iphone-offline/managed-gguf-fixture.test.mts`: fixture run
     yields RunFailed instead of TextDelta/Usage/RunCompleted (GGUF native
     harness gap).
  3. `packages/testkit` byte-fragment cancellation case times out at 5s.
  4. `apps/mobile/platform/abort-compatibility.test.mts` imports
     `../node_modules/expo/src/winter/AbortSignal`, absent from the
     installed expo layout.
  5. `packages/storage/sqlite/extensions` core-v1 migration case expects 7
     ledger versions and observes 8.
- Real-host/device proof remains pending (labeled fixture evidence only):
  live LM Studio host (T159G), live SearXNG, live Brave/reader endpoints,
  physical iPhone passes for dictation/MCP/tool settings. No fixture-only
  claim clears T128/T159.
- Next: first dependency-ready subsequent batch per TASK_QUEUE.md — batch 1
  remaining voice (T072, T075, T077, T079, T080, then host speech), after
  reading its original cards and PARITY rows. Arena stays held.

## Held dependencies


Arena remains held. Partial tools/voice/group checkpoints do not clear the original T061/T070/T083/T128/T159 dependency graphs.


## 2026-10-10 — Internal iPhone build 15 published

Publication requested by the user; inclusion of the existing Strata API key was explicitly approved for this personal test build. Expo EAS `preview` build [fb3288a3-42f8-4586-8572-4363cca77035](https://expo.dev/accounts/barrett/projects/locallab/builds/fb3288a3-42f8-4586-8572-4363cca77035) finished successfully at 2026-10-10T22:29:33.902Z. Existing application work and task queue were preserved; Arena remains held.

Changed paths for publication:
- `apps/mobile/package.json`: declare four imported workspace dependencies (`tools-builtins`, `tools-mcp-http`, `tools-mcp-lmstudio`, `tools-searxng`).
- `pnpm-lock.yaml`: regenerate entries for all 64 workspace packages, including the audio, speech and tool packages, without reinstalling existing node_modules.
- `apps/mobile/app.json`: increment iOS build number from 14 to 15.
- `apps/mobile/eas.json`: select the preview environment and set the Strata LAN URL/model alias. API key is stored as a sensitive project environment variable in Expo; no key literal added to source.
- `packages/speech-system/src/expo.ts`: use extensionless `./index` import for Metro resolution.
- `packages/speech-system/ios/SpeechSystemModule.swift`: use `AVAudioApplication.shared.recordPermission` and invoke `SFSpeechRecognizer.supportedLocales()`.
- `docs/iphone-installation.md`: add latest install link and verified deployment details.

Exact checks/results:
- Local iOS Expo export: exit 0; 1,776 modules bundled; Hermes bundle and assets exported.
- Isolated frozen lockfile validation: exit 0; all 64 workspace manifests accepted.
- Apple autolinking: SpeechSystem pod and SpeechSystemModule discovered among 34 modules.
- Cloud Expo doctor: 20/21 checks passed; one advisory check failed because six existing Expo packages are one patch version behind the current SDK recommendations. Existing pins were retained; cloud native archive completed successfully.
- EAS native iOS build: `FINISHED`; build 15; internal distribution; existing signing credentials reused. Initial attempt `4d33ed43-667c-4bd1-9191-81aa37d53254` was cancelled to correct the native Apple API calls; the published replacement is linked above.
- Downloaded IPA: 26,579,656 bytes; SHA-256 `4781d00bfdc5fbbe7f0f2ce49cd49b6724f8da6c5a9585f2942d7dd407f3a00a`. Registered iPhone included (1 device), signing profile expires 2027-09-27T16:42:38+00:00; approved key, LAN URL and 128K model alias present in JavaScript bundle; SpeechSystemModule linked; both permission descriptions present.
- No physical iPhone runtime checks performed.

Evidence is saved under `tmp/iphone-build15/` (gitignored). Remaining publication blocker: none. Next action for this deployment: install from Safari on the registered iPhone, use the same LAN as the Strata PC, and try chat plus dictation. The application task queue remains at its existing next card.
