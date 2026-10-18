# Continuation progress

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../../plans/POWERSHELL.md).

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

## 2026-10-13 T072 (P07) — iOS system TTS output half (code + fixtures)

- `packages/audio/session/src/ports.ts`: `SpeakOptions` gains optional
  `language` (BCP-47) and `pitch` (multiplier, 1.0 normal); coordinator
  passes options through untouched (coordinator.ts:117-148 verified).
- `packages/speech-system/ios/SpeechSystemModule.swift`: added
  `AVSpeechSynthesizer` half to the existing `SpeechSystem` module —
  `isSpeaking`, `getSpeakAvailability`, `getSpeechVoices`, `speak`
  (voice-identifier-then-language voice choice, rate/pitch multipliers
  clamped 0.5-2.0 around `AVSpeechUtteranceDefaultSpeechRate`),
  `stopSpeaking`, delegate didFinish/didCancel settle. Busy guard rejects a
  second utterance with `BUSY`; interruptions settle `CANCELED`.
- `packages/speech-system/src/index.ts`: `SystemVoice`,
  `NativeSystemSpeechOutput`, `SystemSpeechOutputPort extends
  SpeechOutputPort` (+`getVoices`), `createSystemSpeechOutput` facade —
  blank text is a silent success, abort races stop-with-canceled, native
  codes map UNAVAILABLE/BUSY/CANCELED/failed, dispose stops then refuses.
- `packages/speech-system/src/expo.ts`: exports
  `speechSystemOutputNative` (same native module, output interface).
- `apps/mobile/composition/audio/system-speech-output.ts` + `.web.ts`:
  native adapter + honest web stub ("iPhone's built-in synthesizer, which
  browsers do not expose") matching the C04 dictation pattern.
- Tests: `packages/speech-system/test/system-tts.test.ts` (12 tests —
  availability, voices, request mapping incl. omitted optionality, blank
  text, busy, interrupt-canceled, abort-stops, pre-aborted, rejection
  mapping, idempotent stop, dispose).
- Evidence (fixture level): `vitest run packages/speech-system` → 22/22
  pass; `vitest run packages/audio packages/speech-kws
  apps/mobile/composition/audio apps/mobile/features/speech` → 33/33;
  `tsc --noEmit` for `packages/audio/session`, `packages/speech-system`,
  `apps/mobile` → exit 0.
- Pending device proof (T159C): this machine has no Swift/Xcode toolchain;
  the Swift additions are not compiled. Requires
  `npx expo prebuild --platform ios --no-install` + Xcode build +
  physical iPhone playback, background/interruption, and the system-voice
  picker wiring (delivered under T080 settings work).

## 2026-10-13 T075 (P07) — per-language voice packs + language filter (code + fixtures)

- `apps/mobile/platform/speech/catalog.ts`: four new installable
  per-language Piper packs — `piper-thorsten-de` (de-DE),
  `piper-denis-ru` (ru-RU), `piper-davefx-es` (es-ES), `piper-siwis-fr`
  (fr-FR), each ~67 MB `vits` sherpa archive. `archiveBytes` verified
  against the GitHub release asset API and `archiveSha256` computed
  locally from full downloads (hashes match sizes exactly); licenses read
  from the rhasspy/piper-voices MODEL_CARD files (thorsten/denis/davefx
  CC0, siwis CC BY 4.0). Derived `speechLanguages` picker list.
- `types.ts`: `SpeechVoice` gains `language` (BCP-47) + `languageName`.
- `index.ts` / `index.web.ts`: re-export `speechLanguages`. No install or
  synthesis code changed — the existing generic vits path
  (modelFile/tokens.txt/espeak-ng-data) covers all four languages.
- `features/speech/screen.tsx`: language chip filter (phone + desktop)
  over the voice-pack cards; testIDs `speech-language-filter` /
  `speech-language-<tag>` / `speech-language-all`. Satisfies VO-14
  "Download languages individually" — one card and Download button per
  language.
- Owned-path drift (C04/C07 precedent): card says `modules/tts-local` /
  `packages/voice-packs/mobile`; repo precedent keeps packs in
  `apps/mobile/platform/speech`. Recorded, not relocated.
- Evidence (fixture level): new `platform/speech/catalog.test.mts` 4/4
  (voice↔model binding, per-language download granularity + labels,
  archive pin sanity, unknown-id rejection);
  `vitest run apps/mobile/features/speech apps/mobile/composition/audio
  packages/speech-system` → 25/25; `tsc --noEmit -p apps/mobile` → exit 0.
- Pending: physical iPhone download/synthesis matrix per language
  (T159C); preview-host `/speech/models/<id>/` assets so the web twin can
  install the four new packs (install currently fails honestly with the
  host-owner message); Kokoro multilingual beyond en/zh stays with the
  single kokoro-multi-lang archive.

## 2026-10-13 T077 (P07) — Local Whisper offline transcription (VO-08)

- Feature: VO-08 local Whisper transcription (models tiny..large-v3,
  language hints, live capture + file transcription).
- Owned-path drift (recorded, C04 precedent): card said
  `modules/whisper/ios` + whisper.cpp Swift; implementation is
  `apps/mobile/platform/whisper/` TS core + bundled
  `@siteed/sherpa-onnx.rn` offline ASR (C01 dependency, native lib already
  in iPhone builds) + a small PCM-capture half in the existing
  SpeechSystem Swift module. Reason: sherpa exposes whisper ASR
  (`initAsr` modelType whisper, `recognizeFromFile`,
  `recognizeFromSamples`, `releaseAsr`) on iOS+web without new whisper.cpp
  bindings; new native code reduced to raw 16 kHz mono PCM capture.
- Files:
  - `apps/mobile/platform/whisper/catalog.ts` — whisperModels tiny/base/
    small/medium/large-v3 (int8 enc/dec + tokens, csukuangfj HF resolve
    URLs, sizes verified via HF file API 2026-10-13; large-v3 fp32 files
    are LFS stubs → int8 only), `requiredFreeBytes = 2x + 64 MB`,
    whisperLanguages (auto/en/de/es/fr/ru/it/pt/zh/ja), guidance copy.
  - `types.ts` (state + outcome codes unavailable|permission|canceled|
    failed), `core.ts` `WhisperTranscriber` (injected fs/engine/capture:
    disk fit gate, per-file skip-if-complete + size verify, ready.json
    marker `verification:"size-only"` (HF publishes no checksums),
    cancelInstall via AbortController, engine signature `model+language`
    re-init, transcribeFile, listen = capture-then-recognize where handle.
    stop() finalizes and abort() cancels without recognizing),
    `index.ts` (expo-file-system legacy download w/ progress+abort,
    Paths.availableDiskSpace, lazy sherpa import w/ justification comment,
    singleton `whisperTranscription`), `index.web.ts` (honest unavailable
    stub — preview host ships no whisper runtime).
  - `packages/speech-system/src/index.ts` + `expo.ts`:
    `NativePcmCaptureModule`/`PcmCapturePort`/`createPcmCapture` +
    `speechSystemCaptureNative`.
  - `packages/speech-system/ios/SpeechSystemModule.swift`: PCM capture
    half (AVAudioEngine+AVAudioConverter → 16 kHz mono float;
    request/start/stop/cancel; BUSY guard vs dictation).
    AUTHORED-UNCOMPILED (no macOS toolchain — same class as T072/C04).
  - `apps/mobile/composition/audio/whisper-input-port.ts` (factory:
    DictationInputPort over OfflineTranscription — abort=finalize/
    cancel=discard like system dictation, locale→whisper code map,
    busy/unsupported/permission AudioResult mapping) + `whisper-input.ts`
    (singleton wiring `whisperInputPort`).
- Tests (fixture): `apps/mobile/platform/whisper/whisper.test.mts` 10/10;
  `apps/mobile/composition/audio/whisper-input-port.test.mts` 5/5.
  Batch `vitest --root C:/code/cht apps/mobile/platform packages/
  speech-system packages/audio apps/mobile/composition/audio
  apps/mobile/features/speech` → 71/71 tests; only failing file =
  pre-existing C10 `platform/abort-compatibility.test.mts` (module path,
  unrelated). `tsc --noEmit -p apps/mobile` = 0;
  `-p packages/speech-system` = 0.
- Bug caught by fixtures: `listen` abort listener was registered with
  event name `"once"` instead of `"abort"` (outcome never resolved);
  fixed in core.ts:346 with `{ once: true }`.
- Evidence level: fixtures + typecheck. Pending device proof (T159C):
  offline transcription of fixture audio on iPhone, per-language accuracy,
  large-v3 disk/RAM fit gate on device, long-capture bridge cost
  (`recognizeFromSamples` marshals number[] — optimize on device if slow),
  compiled Swift for the capture half.

## 2026-10-13 T079 (P07) ElevenLabs + Grok/xAI cloud voices — VO-04

- New workspace package `packages/speech/cloud` (`@locallab/speech-cloud`; pnpm glob `packages/*/*` already covered it; resolution via manual junctions under `node_modules/@locallab/` since no pnpm binary exists — lockfile untouched).
- `src/shared.ts`: `CloudVoiceProvider` interface (listVoices + streaming synthesize → byte total via `onChunk`), failure taxonomy (`auth|entitlement|voice-not-found|rate-limit|region|validation|canceled|timeout|malformed|offline`), preflight validators.
- `src/elevenlabs.ts`: `GET /v1/voices` catalog; `POST /v1/text-to-speech/{id}/stream` (model `eleven_multilingual_v2` default, voice_settings stability/similarity_boost/speed validated pre-request, `language_code` only when explicit non-auto).
- `src/xai.ts`: `GET /v1/tts/voices`; `POST /v1/tts` (endpoints/params pinned from docs.x.ai 2026-10-13; API-required `language` sent as requested or `"auto"`; speed 0.7–1.5 validated).
- Credentials per-request via `SecretStore.resolveHeaders(origin, [ref])` (`xi-api-key` / `Authorization`), origin-pinned `createHttpTransport` policy; 401→auth, 403→region(body match)/entitlement, 404→voice-not-found, 429→rate-limit, other 4xx→validation — provider bodies embedded verbatim; **no default-voice substitution anywhere**.
- Commands: `node node_modules/vitest/vitest.mjs run --root C:/code/cht packages/speech/cloud` → 14/14 pass (fixtures: catalog mapping, streamed chunks+byte total, pre-request settings rejection with zero fetches, missing-key→auth, 401/403/403-region/429/404 pass-through, pre-abort→canceled); batch `packages/speech packages/speech-system packages/audio apps/mobile/platform apps/mobile/composition/audio apps/mobile/features/speech` → 85/85 tests (only failing file = pre-existing C10 abort-compatibility import). `tsc --noEmit -p packages/speech/cloud` and `-p apps/mobile` → 0 errors.
- Evidence: fixtures. Pending: recorded live-API smokes (need real keys), persona-binding UI wiring (lands with T080 + PE-07 T054 binding layer), device playback matrix → T159C.

## 2026-10-14 T080 (V05) Voice settings + file transcription UI + retained audio player — VO-05, VO-06, VO-15, VO-16

- Feature module `apps/mobile/features/voice/`:
  - `settings.ts`: `VoicePreferences` (autoRead, engine offline|system|elevenlabs|xai, voiceId, locale, rate, pitch, silenceTimeoutMs, maxListeningMs) + bounds/clamp `parseVoicePreferences`, `effectiveVoiceControls` (engine capabilities hide rate/pitch), `VOICE_ENGINE_CAPABILITIES`, `VOICE_LISTENING_LIMITS` (silence 500–10000 ms, max listening 5–300 s), `SQLiteVoicePreferenceStore` (singleton row, self-ensuring schema, `load(): VoicePreferences | null`).
  - `read-aloud.ts`: `PersonaVoice` keys `speechEngine/speechVoice/speechConnectionId/speechRate` in the Persona profile (verified safe vs the persona-library secret-key blacklist regex), `parsePersonaVoice` (also honors legacy `speechVoiceId`), `personaVoicePatch` (emits explicit nulls to unbind), `resolveReadAloudTarget(prefs, persona)` → offline|system|cloud|**unbound** (cloud persona lacking voice/connection reports honestly — never silently switches).
  - `imports.ts`: `SQLiteTranscriptionImportStore` (id/name/kind/mediaType/audioUri/bytes/durationMs/locale/text/status ok|failed/createdAt; list/latest-first/remove).
  - `container.ts`: `createVoiceStudio({whisper,imports,offlineSpeech,systemSpeech,secrets,connections,fetch?})` — `importFile` (DocumentPicker copy into `Paths.document/AudioImports`, Whisper `recognizeFromUri`, failed transcription still retains playable row), `play/stopPlayback` via `expo-audio` createAudioPlayer, `readAloud(target,text,locale?)` dispatching offline/system/cloud (cloud creds via `SecretStore.resolveHeaders`, abort-checked before `result.ok`, streamed MP4 → cached → played).
  - `screen.tsx`: render-only `VoiceSettingsPanel` (engine/rate/pitch/language dropdowns, auto-read switch, listening-limit inputs with commit-on-blur clamps, test-voice button, import+progress, per-import play/stop/delete rows, per-Persona engine/voiceId/connection bindings). No `Slider` (not in react-native-paper) — pitch is a preset dropdown (0.5–2×).
  - `index.ts` barrel + `voice.test.mts` (settings clamps, controls hiding, persona parse/patch, target resolution incl. unbound, import-row round-trip on a fake SQLite port).
- VO-15 plumbing: `ListenOptions` (`packages/audio/session/src/ports.ts`) + session coordinator forward `silenceTimeoutMs`/`maxListeningMs`; `packages/speech-system` dictation `listen` finalizes on `maxListeningMs` timer (bare `clearTimeout` after await); `apps/mobile/composition/audio/whisper-input-port.ts` same cap → `handle.stop()` auto-finalize; `DictationController.start(handlers, locale, limits)` requires limits and forwards to coordinator. `silenceTimeoutMs` is persisted + forwarded end-to-end and consumed by the native system recognizer only (system `startListening` contract unchanged; local Whisper capture is batch PCM with no local VAD — not faked).
- Chat wiring `apps/mobile/composition/chat/screen.tsx`: runtime gains `voice`, `voiceImports`, `voiceStudio`, `connectionRepo` (single shared store instances); panel branch `panel === "voice"` + "Voice" entry in both nav menus (`chatPageLabels.voice` added in `composition/chat/navigation.ts`); `startDictation` passes persisted listening limits; per-message read-aloud now resolves through `resolveReadAloudTarget` (persona binding wins; legacy `speechVoiceId` honored via parser); auto-read after a completed run when `autoRead` on (skips failed/canceled/empty replies, mounted+active only); Persona bindings persist via `personas.update` profile merge; delete removes row + retained file (`FileSystem.deleteAsync` idempotent).
- Manual junction: `apps/mobile/node_modules/@locallab/speech-cloud` → `packages/speech/cloud` (resolution only; pins/lockfile untouched).
- Commands: `node node_modules/vitest/vitest.mjs run --root C:/code/cht apps/mobile/features/voice apps/mobile/composition packages/speech-system packages/audio packages/speech` → 38 files, 325/325 pass; `... apps/mobile` → 54/55 files, 416/416 tests (only failing file = pre-existing C10 `platform/abort-compatibility.test.mts` import error, must not be "fixed"); `node node_modules/typescript/bin/tsc --noEmit -p apps/mobile` → 0 errors.
- Rule hits fixed en route: no `ReturnType<typeof createVoiceStudio>` in `ChatRuntime` (now the exported `VoiceStudio`); no `clearTimeout` null guard; `effectiveVoiceControls` returns required `rate`/`pitch` keys as `number | undefined` (exactOptionalPropertyTypes).
- Evidence level: fixtures + typecheck. Pending device proof (T159C): real-device read-aloud matrix per engine incl. cloud streaming playback, DocumentPicker on iOS/Android, retained-file survival across restarts, expo-audio background/interruption behavior, system-recognizer silence-timeout + 5-min cap on iPhone, persona-bound cloud voices with real keys.

## 2026-10-14 Batch-1 closure: host speech (T074/T076/T078) blocker record

- Re-verified current tree: `tsc --noEmit -p apps/mobile` = 0; `vitest run --root C:/code/cht apps/mobile` = 54/55 files, 416/416 tests (only failing file = pre-existing C10 abort-compatibility import).
- T074 (VO-09 macOS system speech), T076 (VO-03/RE-08/RE-09 desktop Kokoro/Piper service), T078 (VO-08 Mac Whisper worker) own `apps/companion/**` + `workers/whisper|tts`.
- Blocker (per TASK_QUEUE "genuinely waits for external resources → record and take next ready card"): the Rust companion is a std-only health server + macOS SQLite FFI + secrets; it has no service/job/blob foundation for hosting speech workers, and the phone↔companion relay/forwarding exists only in queue batch 6 (T093–T097); "full desktop" is batch 9 (T133–T156). Every card smoke check requires a packaged Mac companion (no Windows/Linux adapters — explicitly T133). Writing speculative Mac-gated FFI now with zero in-tree consumers risks diverging from the desktop batch contracts.
- T081 (continuous/group/Call Mode) stays inside batch 1 scope only after group foundations (T055–T058) exist — not ready.
- Next ready independent work: batch 2 — personas and groups (T051, T053, T054, T055–T058, partial T061 checkpoint).

## 2026-10-14 T051 (P05) AI Persona Generator — PE-06

- New workspace package `packages/personas/generator` (`@locallab/personas-generator`; manual junctions root + `apps/mobile/node_modules/@locallab/` + package-local contracts junction; pins/lockfile untouched).
- `src/index.ts`: `GeneratedPersonaSchema` (strict zod: name/description/prompt required, tags<=6, appearance via `bundledAppearance` seed palette; extra keys rejected at contract level, e.g. a `memorySharing` key fails), `ProviderPersonaGenerator({port, providerConnectionId, modelId, createId})` — one RunRequest per attempt (`messageId` UUIDv7 required; `json:false` default, no capabilities probe), bounded repair: max 2 attempts, second attempt re-sends prior reply excerpt + rejection reason; `recoveryParse` unfences/slices `{`..`}` before strict parse; `generationDraft(result)` maps success|invalid|failed; mid-stream cancel honored (abort -> canceled, zero extra requests).
- `test/generator.test.ts` 11/11 vitest: valid mapping incl. appearance determinism, strict rejection of extra keys, repair-success path, repair-exhausted -> invalid with excerpt, abort-in-stream -> canceled with no second request, runId-mismatched stream rejected as invalid stream.
- Mobile feature `apps/mobile/features/persona-generator/`: `index.ts` (`PersonaGenerateHandler(idea, signal)`, `PersonaGenerationDraft`), `screen.tsx` `PersonaGeneratorForm` (idea TextInput, Generate/Cancel, AbortController ref + alive ref -> unmount abort, inline note, results never auto-saved), `persona-generator.test.mts` 4 tests (handler contract + draft mapping through the package). NOTE: this test file was lost to a mid-write crash and recreated from scratch this session; package + tsc re-verified fresh afterwards.
- PersonaScreen integration: `features/personas/index.ts` `generatePersona?` prop; `features/personas/screen.tsx` renders `PersonaGeneratorForm` inside the editor card when `!editing && generatePersona`, applying fields to the existing `draft` state (review-before-save: nothing persisted until Save).
- Composition `apps/mobile/composition/chat/screen.tsx`: `generatePersona` at the PersonaScreen call site — guards no-selection/`model-discovery` -> failed("Choose a model in Connections before generating a Persona."); else `ProviderPersonaGenerator` over `createRegisteredChatProvider(selected, {toolsEnabled:false, ninferThinkingControl:false, fetch: providerFetch, secrets, lmStudioIntegrations, nativePort: local-gguf -> createLocalChatPort(runtime.blobs)})`, `providerConnectionId/modelId` from the selected registration, `createId: createChatId`.
- Commands: `node node_modules/vitest/vitest.mjs run --root C:/code/cht packages/personas/generator` -> 11/11; `node node_modules/vitest/vitest.mjs run --root C:/code/cht apps/mobile packages/personas/generator` -> 56/57 files, 431/431 tests (only failing file = pre-existing C10 abort-compatibility import); `node node_modules/typescript/bin/tsc --noEmit -p packages/personas/generator` = 0 and `-p apps/mobile` = 0.
- Crash sweep: rg for generator symbols outside feature dirs -> intended files only; no orphan fragments.
- Evidence level: fixtures + provider-level fake port. Pending: live-provider smoke (any registered model), device proof (iPhone generation flow) -> T159C.
- Next: T053 persona memory scoping.

## 2026-10-14 T053 (P05) Persona memory scoping — ME-04, ME-05, ME-06, ME-07

- New workspace package `packages/memory/scope` (`@locallab/memory-scope`; node:test via `tsx --test`; deps contracts/memory-extraction/personas-library/storage-sqlite-core; junctions root + `apps/mobile/node_modules/@locallab/memory-scope` + package-local).
- `src/index.ts`: `PERSONA_MEMORY_SETTINGS_KEY = "memory"` (Persona profile key), `PersonaMemorySettings{extract?,inject?,share?}`, `readPersonaMemorySettings(profile)` (junk-tolerant), `scopedMemoryPolicy({personaId,profile?},preferences)` -> per-Persona tri-state override over global switches; default Persona keeps global scope/includeGlobal, custom Personas own-persona scope/includeGlobal false. `PERSONA_MEMORY_LIMITS` (associatedFacts 500, promptEntries 200). `SQLitePersonaMemoryScope(db)`: tables `persona_memory_policy` (nullable extract/inject tri-state, share) + `memory_persona_associations`; `associate()` REFUSES persona-owned facts of non-sharing Personas ("Private Persona fact cannot be associated"); global facts associate freely; `sharingPersonaIds()` gates cross-persona prompt merge; `disassociate/policy/setPolicy/clearPolicy/personaIdsWithOwnedFacts`; `resetPersona` = the ONLY clear path (switch is pure policy re-derivation, data untouched); `boundedFragments(groups,budgetCharacters)` dedups via `normalizedContent` with per-persona caps. `setPolicy` with share=undefined keeps the stored value via a follow-up UPDATE (COALESCE upsert cannot distinguish unset).
- `test/scope.test.ts` 6/6 via `node node_modules/tsx/dist/cli.mjs --test packages/memory/scope/test/scope.test.ts` (vitest reports "No test suite found" = runner mismatch like memory-extraction; not breakage). `node node_modules/typescript/bin/tsc --noEmit -p packages/memory/scope` = 0.
- ME-05 app integration: `apps/mobile/composition/chat/persona-memory.ts` `personaMemoryPolicy` now delegates to `scopedMemoryPolicy` (identity profile rides through; the 6 existing persona-memory tests incl. "Persona switch preserves transcript and captured prompt identity survives profile edits" (ME-07) stay green); `initializePersonaMemoryChat` also opens + returns `memoryScope`. `features/personas/index.ts` props `globalMemorySettings?` + `onPersonaMemoryPolicy?`; `features/personas/screen.tsx` "Memory" `PersonaEditorOptions` block: three Paper Switches (save new facts / use saved facts / share) writing `draft.profile.memory` via `readPersonaMemorySettings` merge (extract/inject default to the global switches, share explicit); Save calls `onPersonaMemoryPolicy(record.id, share)` -> composition persists `memoryScope.setPolicy(personaId,{share})`. Composition loads global switches into `personaMemorySwitches` state when the personas panel opens.
- Design note: profile `memory.{extract,inject}` are the run-time policy source (ride PersonaRunSnapshot); `persona_memory_policy.share` gates association/sharing store-side; association UI not shipped (associations API tested at package level).
- Commands: `node node_modules/vitest/vitest.mjs run --root C:/code/cht apps/mobile` -> 55/56 files, 420/420 tests (only failing file = pre-existing C10 abort-compatibility import); `node node_modules/typescript/bin/tsc --noEmit -p apps/mobile` = 0.
- Evidence level: fixtures (in-memory SQLite) + typecheck. Pending: device proof (privacy flows on iPhone; cross-persona association UX in a later card).
- Next: T054 persona bindings (read `plans/tasks/P05/T054.md` first; PE-09 ComfyUI refs may be record-blocked on T086).
## 2026-10-14 — T054 Persona bindings checkpoint (PE-02, PE-07, PE-08, PE-09)

### Changed
- `packages/personas/bindings` (NEW): profile-key binding layer — `PERSONA_MODEL_SETTINGS_KEY`/`PERSONA_MEDIA_SETTINGS_KEY`, `readPersonaModelSettings` (EntityId-validated; display names rejected), `personaModelPatch`, `readPersonaMediaSettings` (opaque workflow refs), async `resolvePersonaModelBinding` (unbound/bound/missing; missing carries the exact no-substitution message), `bindingOptions` (removed identities stay selectable).
- `apps/mobile/features/persona-bindings` (NEW): `personaModelChoices` (label "Use this chat's model" default + `${label} — ${modelId}` entries + removed-binding entry), `personaProfileWithModel` (stores connection ID identity, never label), `personaModelChoice`.
- `apps/mobile/features/personas`: prop `modelConnections`; PersonaScreen editor gains "Model" dropdown (writes profile.model via persona-bindings helpers; removed binding shown as "Removed binding (choose another or reset)") and "Media" block stating the app default workflow is used until ComfyUI workflow binding ships — nothing substituted.
- `apps/mobile/composition/chat/screen.tsx`: `personaConnections` state loaded from `runtime.registry.list()` (model-discovery placeholder filtered) when the Personas panel opens; passed as `modelConnections`; SEND path resolves `resolvePersonaModelBinding(identity.profile, registry.get)` — a BOUND persona uses its registered connection for the whole run (context discovery, provider port, model record, cache key — everything keys off the resolved registration); a MISSING binding sets the error notice and aborts the send with "…no other model was used." Unbound personas keep the chat's selected provider.
- Junctions: root+apps/mobile `@locallab/personas-bindings`; package-local contracts.

### Evidence
- `tsx --test packages/personas/bindings/test/bindings.test.ts` — 6/6 pass (identity-only bindings, explicit-null unbind, no substitution on missing, opaque media refs, removed-binding option lists).
- `tsc --noEmit -p packages/personas/bindings` = 0; `tsc --noEmit -p apps/mobile` = 0.
- `vitest run --root C:/code/cht apps/mobile` — 56/57 files, **423/423** tests (only allowed abort-compatibility failure); includes persona-bindings.test.mts 3/3 (identity-not-label smoke + removed-binding visibility).
- Feature IDs: PE-02 model binding (profile key `model.connectionId` = provider connection identity; run-path enforcement verified at fixtures level), PE-07 voice profile binding — shipped earlier (T080 profile speech keys, editor Voice dropdown, unbound read-aloud honesty; Kokoro speed = speechRate 0.75–1.5 dropdown), PE-08 persona-scoped custom parameters — already shipped via `chat_parameter_presets` persona scope (SQLiteChatSettingsStore + chat-settings personaEnabled) and unchanged here, PE-09 media workflow refs — storage contract + opaque-reference parsing + unavailable-binding UX shipped; workflow selection UI depends on the media/ComfyUI registry (T086, batch 5).
- Device proof: pending (same lane as T053/T051).
- Note: PersonaSchema `model_id`/`parameter_preset_id` columns remain null/unused — bindings ride the profile map (zero migration; `PersonaRunSnapshot.profile` carries them into every send).

### Next
- T055 groups foundation (read plans/tasks/P05/T055.md first; T081 stays blocked until groups ship).
## 2026-10-14 — T055 Group setup and participant editor (GR-01, GR-02, GR-03, GR-04, GR-11, GR-12)

### Changed
- `packages/groups/config` (NEW): `GroupParticipantDraft`/`GroupRoomDraft` (room scenario + user display name GR-11; per-participant name/accent/prompt/voice-opaque/tools GR-04), `validateGroupRoom` (GR-12: participant-indexed actionable errors — deleted Persona, connection removed from Connections ("no other model is substituted"), `model-discovery` placeholder, both/neither identity source, duplicate Persona seat, room-level display-name/<2-participant; same connection+model in multiple seats allowed = GR-02 roles), `SQLiteGroupConfigStore` (`group_rooms`+`group_participants` feature-owned tables, save/load/list, turn order = list order, JSON voice).
- `apps/mobile/features/group-setup` (NEW): `personaSeatFromIntent` (Add-to-group seats Persona identity, not label), `directModelSeat` (connection ID + exact modelId = GR-03 direct model), `groupSeatChoices` (Personas then direct connections); `GroupSetupPanel` (room name/scenario/user display name, per-seat name/system-prompt/remove, saved-room dropdown to reopen, "Validate and save group" runs `validateGroupRoom` first — invalid bindings block save with per-participant messages inline).
- Composition: `chatPageLabels.groups` + both nav arrays + icon; panel branch `panel === "groups"` renders GroupSetupPanel (store from `runtime.db`); `SQLiteGroupConfigStore.initialize` in `initializeMobileChatComposition`; persona "Add to group" button enabled (removed `groupUnavailableReason`), `onAddToGroup(intent)` stages `pendingGroupSeat` + opens Groups panel; `personaConnections` effect now loads for personas OR groups panel.
- Junctions: root+apps/mobile `@locallab/groups-config`; package-local contracts + storage-sqlite-core.

### Evidence
- `tsx --test packages/groups/config/test/config.test.ts` — 4/4 pass: participant-level bad-binding errors; mixed providers + one model two roles pass; half-bound/both-source/placeholder refused; **real node:sqlite round-trip reopens saved room intact** (bindings, turn order, voice JSON; re-save replaces seats cleanly).
- `tsc --noEmit -p packages/groups/config` = 0; `-p apps/mobile` = 0.
- `vitest run --root C:/code/cht apps/mobile` — 57/58 files, **427/427** tests (only allowed abort-compatibility failure); includes group-setup.test.mts 4/4 (identity-seat, direct-seat binding, choice ordering, empty draft).
- Feature IDs: GR-01 shared-thread config side (transcript runtime = T058/T056), GR-02 same-model-different-roles validation ✓, GR-03 persona-or-direct picker ✓, GR-04 name/accent/prompt/tools persisted (voice stored opaque; voice UI wiring = T058), GR-11 user display name + persistent scenario ✓, GR-12 pre-launch validation with participant-level errors ✓.
- Pending proof: device UI walk; actual multi-model live group turns = T056 (depends T037 summaries, batch 3) and T058 transcript UI next.

### Next
- T058 group transcript + per-participant tools/voice UI (depends T055 ✓/T014 ✓/T006 ✓ — actionable); T056 stays after batch 3 T037; then batch 3 cards per TASK_QUEUE.
## 2026-10-14 — T058 Group transcript + per-participant tools/voice UI (GR-13, VO-13)

### Changed
- `apps/mobile/features/group-chat` (NEW): `GroupTranscriptEntry` (speaker seat/name/accent), `groupSpeakQueue` (ordered playback intents, seat voice → `SpeakOptions{voiceId,rate}` per participant — no global voice), `playGroupSpeakQueue` (frozen `SpeechOutputPort` from `@locallab/audio-session`; per-seat status; one seat's failed voice marks only that seat, later replies continue), `seatWithTools` (seat-local tools; no global toggle touched); `GroupChatScreen` (scenario banner, attributed transcript, per-participant Ask chips + tools switches + queued/speaking/failed status rows, "Play replies in order", honest "turn engine arrives with group scheduling" note).

### Evidence
- `apps/mobile/features/group-chat/group-chat.test.mts` 3/3 vitest (fake `SpeechOutputPort`): textual order preserved (user entries skipped); **distinct voice bindings per seat** (`voice-ada`/rate vs `voice-grace`); failing voice → `failed` status for that seat only + "Other replies continue." while later replies still play; seat tools toggle leaves other seats byte-identical (global tools never changed).
- `tsc --noEmit -p apps/mobile` = 0; full `vitest run --root C:/code/cht apps/mobile` = 58/59 files, **430/430** (only allowed abort-compatibility failure).
- Feature IDs: GR-13 (ordered playback with per-seat voices + independent failures) ✓; VO-13 (per-participant voice bindings drive playback) ✓.
- Pending proof: device UI walk; live multi-model group turns + Ask→turn engine wiring = T056 (needs T037 summaries from batch 3). Composition opens GroupChatScreen when the group runtime lands (panel surface built per owned paths).

### Next
- T056 (scheduler) and T057 (multi-voice output) remain gated on T037; proceed to batch 3 per TASK_QUEUE order (T033/T034 imports, T031 downloads, T028/T030 MLX, T037 summaries, T045 embeddings, T043/T039 attachments/math).
## 2026-10-14 — T056 + T057 Group scheduler + parallel streams (GR-05…GR-10)

### Unblocked
- `plans/status/P04.md` shows T037 at **review** (code shipped, only native wiring pending) → T056 dependencies (T037/T053/T055) satisfied at implementation level.

### Changed
- `packages/groups/turns` (NEW, `@locallab/groups-turns`): `planGroupUserTurn` freezes the eligible speaker set per user turn — round-robin seating order (GR-05); autonomous follows @mentions (case-insensitive display-name handles) else all seats, rounds capped at `GROUP_AUTONOMOUS_ROUND_CAP = 5` (GR-06); manual mode runs only the Ask-chip seat, refuses with no seat (GR-07); `replyToUserOnly` ends after one reply to the user (GR-08). `runGroupUserTurn` serial port execution: speaker identity only from the frozen plan, room scenario carried into instructions, abort terminates the whole user turn (later seats never start; completed reply preserved).
- `packages/groups/parallel` (NEW, `@locallab/groups-parallel`): `ModelLeaseRegistry` (GR-10) — per-host capacity, FIFO queue with waiter-carried model keys, pump grants next when slot frees, models unload only at zero leases, abort removes waiters; `runGroupTurnParallel` (GR-09) — concurrent per-speaker generation, interleaved chunks carry their speaker, per-participant failure isolation, cancellation releases all leases.
- Junctions: root `@locallab/groups-turns` + `@locallab/groups-parallel`; package-local deps.

### Evidence
- `tsx --test packages/groups/turns/test/turns.test.ts` — 7/7 (deterministic mode fixtures: order frozen, unmentioned/manual never run, cap=5, reply-to-user-only one reply, stop ends whole turn, empty-room/manual refusals).
- `tsx --test packages/groups/parallel/test/parallel.test.ts` — 4/4 (interleaved chunk attribution; one failure keeps others' successes; capacity-1 host serializes with max-concurrency 1 and no deadlock, models unloaded after; cancellation → 3 failed, zero loaded, zero active).
- `tsc --noEmit -p packages/groups/turns` = 0, `-p packages/groups/parallel` = 0.
- Pending proof: device live group run (turn engine composition wiring rides T061 gate: groups UI needs T060 which user holds); multi-model VRAM behavior = device-side.

### Next
- Groups batch T055–T058 + T056/T057 all at implementation level. Recheck T081 hold and remaining parity gaps (attachments→ChatEngine wiring, embeddings real runtime, MLX/downloads native = external-device blocked).
## 2026-10-14 — T081 (partial) Continuous/group voice session core (VO-11, VO-12, GR-13)

### Done (owned path `packages/audio/conversation`)
- NEW `@locallab/audio-conversation`: `ConversationVoiceSession` — cancelable speak→listen→send cycle over `@locallab/audio-session` ports. Participant replies play **in order with each speaker's own voiceId**; then one user utterance is captured and handed to `onUserText` for sending. `cancel()` aborts the current phase (port `stop()` + AbortSignal), never starts capture after cancel; playback/capture failures surface honestly (`capture failed: <message>`) and leave the session idle and reusable; overlapping cycles are refused.
- Junctions: root `@locallab/audio-conversation`, package-local `@locallab/audio-session`.

### Evidence
- `tsx --test packages/audio/conversation/test/conversation.test.ts` — 4/4 (ordered per-voice playback + single listen + send; cancel mid-playback → no capture, phase idle; failed capture surfaces message without sending; no cycle overlap).
- Combined `tsx --test` for audio-conversation + groups/turns + groups/parallel: 15/15.
- `tsc --noEmit` for `packages/groups/config|turns|parallel` + `packages/audio/conversation`: 0 each (`lib: ["ES2024"]` added per existing package convention for `Promise.withResolvers`).

### Pending (external prerequisites — not pretended ready)
- `modules/call-mode/ios` CallKit integration (card steps 2–3): foreground user-initiated CallKit/audio session, lock-screen continuation, earpiece/route changes, mic release → needs Xcode + physical iPhone (same device gate as T017B/T026/T028/T031). Functional smoke "physical iPhone completes one foreground listen/send/speak loop" = pending proof; not claimed.

### Next
- Batch-3 parity audit for actionable JS-level slices: attachments→ChatEngine wiring (T043 remainder), embeddings verification (T045), T061 partial checkpoint. Native/device slices recorded blocked.
## 2026-10-14 — Batch 3 parity-debt audit (T033/T034/T031/T028/T030/T037/T045/T043/T039): all remaining slices device/native-blocked

### Findings (fresh source checks, not board text)
- T043 attachment→ChatEngine wiring is ALREADY complete at JS level: `runtime.intake.prepare({refs,…})` → engine request `attachmentRefs` (composition `screen.tsx` :1627-1634, :1872) → provider adapters (anthropic/gemini/mistral/openai-advanced srcs) consume them; gemini/mistral deliberately receive prepared document text with image-only refs. Remaining = native picker/preview/compression engines → iOS device blocked.
- T037 context usage IS surfaced in chat UI (`… input tokens - … messages omitted` line in `composition/chat/screen.tsx`); continuation retry/titles in `packages/chat/engine/advanced` (board: review). Remaining = physical provider behavior + native meter → device blocked.
- T039 rich Markdown/code/inert math renderer mounted through transcript core; `onCopyMarkdown` → `writeClipboardMarkdown` adapter wired (screen :3682-3684). Remaining = physical rendering/accessibility matrix (T159F) → device blocked.
- T028/T030 MLX + T031 downloads + T045 embedding runtime + native FTS5 + T033 native FS: shipped at "review" with Swift/native halves requiring Xcode/Apple Silicon/iPhone — none available on this Windows host. Blocked; recorded per TASK_QUEUE rule.
- No-large-weight-hashing preference preserved: no changes.

### Decision
- Batch 3 has no actionable Windows-only slices left. Next ready batch: 4 (T067 hosted search, T068 isolated code worker, T069 presentation, T070 provider/group integration) — JS-level portions actionable.

### Next
- Read T067/T068 cards; implement actionable JS slices; record device halves pending.
## 2026-10-14 — T067 Hosted search facade + API route (TO-16, TO-17, TO-19)

### Changed
- NEW `packages/tools/hosted-search` (`@locallab/tools-hosted-search`): `HostedSearchService` — opt-in facade over bring-your-own `HostedSearchUpstream` adapters; explicit **not-configured** state when enabled without an upstream (exact guidance message, nothing is guessed); local sliding-window account limits with `retryAfterMs`; structured error codes (`disabled`/`not-configured`/`limit-reached`/`malformed-query`/`upstream`/`canceled`); source normalization (http(s)-only URLs, control-char-free bounded texts, dropped entries counted); query bounded 400 chars; `createMockHostedSearchUpstream` deterministic fixture table (unknown query → zero sources). Authentication stays in the service layer in front; the package logs nothing (test console-spy asserts zero calls).
- NEW `services/api/features/search/`: `registerHostedSearchRoute(app, service)` GET /search maps structured codes → HTTP statuses (409 not-configured, 403 disabled, 429 limit + retryAfterMs, 400 malformed, 502 upstream); `search-route.test.ts` via `app.inject`.
- `services/api/package.json` workspace dep added; root junction `@locallab/tools-hosted-search`.

### Evidence
- `tsx --test packages/tools/hosted-search/test/hosted-search.test.ts services/api/features/search/search-route.test.ts` — 7/7 (enabled path with bad-URL drop + no-logging spy; explicit missing-upstream state; disabled no fallback; limit with retry timing; upstream failure not echoed verbatim; unknown mock query → zero; route status mapping incl. 429).
- `tsc --noEmit -p packages/tools/hosted-search` = 0; feature route typecheck = 0.
- Pending proof: real paid upstream account behavior = T159G (external).

### Next
- T068 sandbox: `packages/tools/sandbox` contracts + `workers/sandbox` Docker worker; Docker 29.7.2 available on host → bounded fixture runs are actionable.

---

## 2026-10-14 — T068 Python/JS sandbox worker (TL-08): contract level + docker engine blocked

**Cards:** T068 (batch 4). Feature IDs: TO-* sandbox (TL-08).

**Changed paths (new):**
- `packages/tools/sandbox/src/index.ts` — `DockerSandboxRunner` (fresh-container `docker run` with verbatim isolation flags: `--rm --network none --read-only --tmpfs /work:rw,size=64m,mode=1777 --memory/--memory-swap --cpus --pids-limit 64 --user 65534:65534 --security-opt no-new-privileges --cap-drop ALL`; zero host mounts asserted), `validateSandboxJob` (language allow-list, non-empty code, timeout 100–120 000 ms, output >0, memory cap 1024 MB, cpus cap 2, ≤8 artifacts with safe names), status taxonomy `ok|timeout|canceled|runtime-error|quota|unavailable`; outer kill timer (timeout+5 s), abort → SIGKILL → `canceled`, non-JSON + exit 137 → `quota` ("exceeded its memory limit"), `protected spawnProcess` seam for tests.
- `workers/sandbox/Dockerfile`, `run.sh`, `worker.mjs` — worker: job JSON on stdin (2 MiB cap), writes program (`0o600`), inner timeout kill → `timeout`, per-stream output ceilings, artifact collection from `/work/out` (256 KiB base64 cap, `truncated` flag, missing files skipped), SIGKILL-killed child → `quota`, nonzero exit → `runtime-error`.
- `services/api/features/sandbox/index.ts` — optional service POST /sandbox/run: malformed job 400, invalid limits 400, runner unavailable 503; programs/outputs never logged here (auth is the service layer in front).

**Commands + results:**
- `node node_modules/typescript/bin/tsc --noEmit -p packages/tools/sandbox` → 0.
- `node node_modules/tsx/dist/cli.mjs --test packages/tools/sandbox/test/sandbox.test.ts` → 4/4 (validation rejections; isolation flags verbatim incl. no `-v`/bind; abort→canceled; worker-JSON pass-through + bad-JSON mapping).
- `node node_modules/tsx/dist/cli.mjs --test services/api/features/sandbox/sandbox-route.test.ts` → 1/1 (400 malformed-job, 400 invalid-limits, 503 unavailable via missing docker binary).
- Inline route typecheck (`--target ES2022 --lib ES2024 --module preserve --moduleResolution bundler --strict --skipLibCheck`) → 0.
- Root junction `@locallab/tools-sandbox` created; `services/api/package.json` gained the workspace dep.

**Pending proof:** live two-language fixture smoke blocked — Docker CLI 29.7.2 present but the Desktop **engine never started** (`docker run` → npipe missing; 90 s engine wait failed; first-run/GUI-gated). `docker build` + bounded python+JS fixture execution = pending host daemon. Evidence level: contract tests (fakes) + tsc. Card NOT marked complete (smoke criterion unproven).

## 2026-10-14 — T069 tools presentation: already shipped (audit); T070 partial checkpoint only

**T069 (TO-08/12/14/15):** audit found all three card steps implemented: per-turn tool + web-search switches in `features/composer/advanced/composer.tsx` (ToolToggle rows `composer-search-chip`/`composer-tool-*`, disabled while busy; payload per-turn selection), transcript rows keyed to actual run messages (`invocationId` rows in `features/transcript/core/transcript.tsx`), and missing-terminal-answer guidance twice over: `assistantStatusLabel` "Output limit reached. Increase maximum output tokens…" (+transcript test asserts it), `readTranscript` spreads projection `finishReason` (chat-projection keeps it), and the advanced engine auto-continues abrupt `length/max_tokens` completions (`isAbruptFinish` + `withContinuation` in `packages/chat/engine/advanced/src/index.ts`). Per-seat tool policy in group chat shipped in T058. Remaining T069 slices = device interaction matrix (tap targets, screen reader announcements) — device-blocked; no code change.

**T070 (TO-20):** partial checkpoint only. `apps/mobile/features/tool-settings/mcp-servers.ts` (SQLite store + mcpErrorResult) and `mcp-panel.tsx` exist for the global MCP layer; per-persona/per-participant MCP bindings + persona-aware availability require the full persona system (T061), which the user holds (Arena). No further T070 slice is actionable; batch 4 boundary reached.
## 2026-10-14 Batch 5 — T084 media job engine (IM-01/IM-02) — Implementation

- New `packages/media/engine/` (`@locallab/media-engine`): `MediaJobService` over `@locallab/jobs` JobScheduler (registers `image-generate` handler; media default limit 1; completed jobs keep `result.outputRefs`, `job.error` = JSON.stringify(TypedError) so the UI never parses provider strings). Settings store (enabled/promptReview/autoGenerate), durable review-draft table `media_review_drafts` (snapshot frozen at request; `approveReview` enqueues + deletes draft; `cancelReview` discards; SQLite impl + store interface for hosts). `requestGeneration` semantics: disabled → suppressed with user-facing reason; chat-triggered requests obey autoGenerate (button requests bypass only autoGenerate, never the master toggle); promptReview → idempotent draft (key = conversation|prompt|workflow); duplicate enqueue collapses via scheduler idempotency.
- `packages/jobs/package.json` gained `"./memory-store"` export (documented test adapter reused by media tests; jobs tests still 5/5).
- Checks: `node node_modules/typescript/bin/tsc --noEmit -p packages/media/engine` → 0. `node node_modules/tsx/dist/cli.mjs --test packages/media/engine/test/media-engine.test.mts` → 5/5. Card smokes proven at contract level: duplicate enqueue returns one job (same id, handler runs once); auto-generation toggle obeyed; canceled output never marked complete (late gate result dropped, state stays canceled, result undefined); offline/missing-checkpoint surface typed errors.
- Pending: mobile media settings UI + gallery (T087/T089), backend adapters wired per below, real backends via T159C matrix.
## 2026-10-14 T085 AUTOMATIC1111 adapter (IM-03/IM-04) — Implementation

- New `packages/media/a1111/` (`@locallab/media-a1111`): `A1111Client` — API discovery (`/sdapi/v1/sd-models`, `/sdapi/v1/samplers`), `buildRequestBody` mapping every applied parameter (prompt/negative/steps/CFG/size/seed/sampler/HR: enable_hr+hr_upscaler+hr_scale+denoising_strength, restore_faces, override_settings.sd_model_checkpoint), `txt2img` with pre-queue `validate` (missing checkpoint → typed missing-model, unknown sampler → unsupported, both BEFORE any txt2img POST), progress polling `/sdapi/v1/progress` during generation into `reportProgress`, b64 output decode; HTTP failures typed (fetch reject → offline recoverable; non-2xx → host-stopped; abort rethrown so scheduler marks canceled). `A1111MediaBackend` implements the engine `MediaBackendPort`: reads frozen `workflowSnapshot.definition` params (`snapshotParams`), writes decoded images through an injected blob sink (managed-blob catalog wiring lands with the mobile integration card), returns `outputRefs`.
- Checks: `node node_modules/typescript/bin/tsc --noEmit -p packages/media/a1111` → 0. `node node_modules/tsx/dist/cli.mjs --test packages/media/a1111/test/a1111.test.mts` → 5/5: exact request-body mapping fixture, discovery→POST ordering + decoded bytes, progress polled during a slow generation (0.6 reported), unavailable checkpoint/sampler/API rejected before queueing, snapshot→blob-ref conversion incl malformed-definition.
- Pending: real image-server generation is T159C (external prerequisite: reachable A1111 instance); device settings UI for baseUrl wiring deferred to mobile integration.
## Next — Batch 5
- T086 ComfyUI adapter next; T087 queues/video; T088 Core ML (device-gated); T089 gallery; T091 persona media (persona-bindings gated); T092 integration.

## 2026-10-14 T086 ComfyUI workflows + LoRA adapter (IM-05..IM-08) — Implementation

- New `packages/media/comfyui/` (`@locallab/media-comfyui`): `defaultGraph` txt2img graph (CheckpointLoaderSimple → dual CLIPTextEncode at CLIP slot 1 → EmptyLatentImage → KSampler(seed/steps/cfg/sampler_name/scheduler) → VAEDecode → SaveImage); `applyLoras` chains LoraLoader nodes (strength_model/strength_clip) between checkpoint and all original consumers without disturbing the lora chain itself; `validateGraph` pre-queue checks (object shape, class_type, node-link references exist, SaveImage sink present); `applyPlaceholders` typed `{{seed}}`-style substitution for API-JSON graphs (strings/numbers by placeholder name, unknown placeholder rejected); workflow sources: default | api-json | saved (host loader port).
- `ComfyUiClient.run`: POST /prompt (graph + client_id; node_errors → malformed; fetch reject → offline recoverable; non-2xx → host-stopped), progress via injected WebSocket port (`/ws?clientId=`; progress value/max → reportProgress; execution_error captured and surfaced as host-stopped on the next history poll — no throw inside message callbacks), outputs from /history, binary-safe `/view` fetch (arrayBuffer bytes verified round-trip incl. NUL/0xFF). `ComfyUiMediaBackend` implements the engine `MediaBackendPort` (snapshot definition → params incl. loras, blobSink refs out).
- Fixes caught by fixtures: default graph had CLIP links on slot 0 (checkpoint model) instead of slot 1 — real ComfyUI would have failed; lora patch loop initially rewrote the lora nodes' own links.
- Checks: `node node_modules/typescript/bin/tsc --noEmit -p packages/media/comfyui` → 0. `node node_modules/tsx/dist/cli.mjs --test packages/media/comfyui/test/comfyui.test.mts` → 8/8: mapped-values graph, LoRA chaining incl. strengths, validation failures (missing refs / no SaveImage / non-object), typed placeholder substitution, POST→progress→outputs flow (0.5 progress reported, graph posted intact), execution_error/node_errors typed, binary output integrity, snapshot→blob end-to-end.
- Pending: real ComfyUI graph execution is T159C (external prerequisite: reachable server); WebSocket port is host-injected — native mobile wiring lands with the integration card.
## Next — Batch 5
- T087 queues/video next; T088 Core ML (device-gated); T089 gallery; T091 persona media (persona-bindings gated); T092 integration.

## 2026-10-14 T087 ComfyUI queue + video outputs (IM-13, UP-03) — Implementation

- New `packages/media/queue/` (`@locallab/media-queue`): `ServerJobLedger` (durable jobId → server job id; `SqliteServerJobLedger` table `media_server_jobs` + memory variant); `RecoveringMediaBackend` wrapper enforcing a hard `maxConcurrentRemote` bound (typed recoverable "quota" failure; the over-limit job never reaches the remote server) and, on restart, re-attaching via `ledger.lookup(jobId)` + `backend.resume` instead of resubmitting; `mediaQueueRows(scheduler, ledger)` UI view (state, progress, attempt, serverJobId).
- Engine port extension (`packages/media/engine`): `MediaBackendPort.generate` context gains `jobId` + `reportServerJob(serverJobId)` (reported as soon as the backend learns the server id); new optional `resume({serverJobId, ...})`. Handler passes `jobId: context.job.id`; engine default reportServerJob is a no-op — the queue wrapper wires the ledger.
- ComfyUI adapter: `ComfyUiClient.run` split into `followPrompt(promptId, …)` (history polling + WS progress; no POST) with `run` = POST + `onPromptId` callback + follow. `ComfyUiMediaBackend.generate` reports the prompt id through `reportServerJob`; `resume` follows the recorded prompt id and collects outputs — verified the resume path issues zero `/prompt` POSTs.
- New `packages/media/video/` (`@locallab/media-video`): `recognizeArtifact(filename, bytes)` magic-sniffing for workflow outputs: GIF89a (duration = summed GCE frame delays), MP4 `ftyp`+moov/mvhd v0/v1 duration (incl. 64-bit), animated WEBP (VP8X animation flag, summed ANMF durations × iterations), APNG (acTL/fcTL delays), static WEBP/PNG stay images, extension fallback (webm/mov/…).
- Checks: `node node_modules/typescript/bin/tsc --noEmit -p packages/media/{engine,a1111,comfyui,queue,video}` → all 0. `node node_modules/tsx/dist/cli.mjs --test packages/media/{engine,test…,video/test/video.test.mts}` combined → 30/30 (engine 5, a1111 5, comfyui 9 incl. resume-no-resubmit, queue 4: bounded submissions, reconnect-resume via fresh scheduler over same durable store + ledger cleared after completion, sqlite ledger statements, cancellation with serverJobId visible mid-flight, video 7 incl. playable GIF/MP4/WEBP/APNG fixtures).
- Semantics note: the scheduler already defers over-limit jobs (category limits); the wrapper's quota throw is defense-in-depth against misconfiguration — it fires only when concurrent submits exceed `maxConcurrentRemote`.
- Pending: real video-producing graph + long-queue behavior on a live ComfyUI server = T159C (external prerequisite: reachable server). Server-side interrupt of a canceled-but-still-running ComfyUI prompt (POST /interrupt) not implemented — queue cancel only stops local tracking.
## Next — Batch 5
- T088 Core ML next (likely device-gated); then T089 gallery, T091 persona media, T092 integration.

## 2026-10-14 T088 iOS Core ML Stable Diffusion (IM-10, IM-11) — BLOCKED (device/native)

- Card read: owned path `modules/stable-diffusion/ios`; steps require Swift wrapping of Apple's pinned Core ML pipeline, model download/select, RAM/thermal availability.
- Blocker: Windows workstation has no Xcode/Swift toolchain or iPhone; Core ML is Apple-framework-only — nothing compilable/testable here. Same precedent as T081 CallKit half. Added to device/native-blocked list. Functional smoke criteria ("supported iPhone generates offline image", hardware gating) remain pending device access.

## 2026-10-14 T089 Mobile media prompts + generated gallery (UP-02) — Implementation

- Engine extension: `MediaReviewStore.list()` added (interface + `SqliteMediaReviewStore.list()` = `SELECT * FROM media_review_drafts ORDER BY created_at ASC, id ASC` via `getAllAsync`); engine test `MemoryReviewStore` fake gained list(); review test now asserts pending draft visible via `reviews.list()` and empties after approve+cancel.
- New `apps/mobile/features/media/` (junctions `apps/mobile/node_modules/@locallab/{media-engine,media-queue,media-video}` created; no package.json edits per repo junction convention):
  - `index.ts` — pure view logic over persisted jobs: `mediaJobViews` (filters `image-generate` kind + `MediaSnapshotSchema`-valid input; typed-error JSON `job.error` → user message via `errorText`, raw strings survive), `galleryAssets(views, scope)` (completed-only; global vs conversation scoping; per-outputRef tiles with `recognizeArtifact` extension metadata → playable kind/MIME/duration), `reviewRows`, `outcomeNote` (job/review/suppressed user feedback), `DEFAULT_WORKFLOW`.
  - `screen.tsx` — `MediaPanel`: settings switches (enable / prompt-review / auto-generate, disabled cascade), workflow picker (NativeDropdown), prompt input + Generate (requestGeneration "button" path + outcome note), pending-review cards (approve/discard → engine approveReview/cancelReview), job queue (running progress %, cancel via service.cancelJob), gallery with scope picker; state rebuilt from durable stores (`scheduler.list()` + `reviews.list()`) so reopen/update preserves visibility.
  - `media.test.mts` — 6 vitest tests with REAL engine pieces (JobScheduler + MemoryJobStore + MediaJobService): failed job surfaces typed error message not raw JSON; non-media kinds/malformed snapshots ignored; gallery conversation scoping + reopen rebuild from same durable store (incl. .mp4 → video/mp4 playable metadata); running jobs hidden from gallery; review drafts → rows; outcome notes.
- Checks: `node node_modules/typescript/bin/tsc --noEmit -p apps/mobile` → 0 errors (whole app incl. new screen). `node node_modules/vitest/vitest.mjs run --root C:/code/cht apps/mobile` → Test Files 1 failed | 59 passed (60), Tests 436 passed (436) — baseline preserved (only allowed `apps/mobile/platform/abort-compatibility.test.mts` collection failure). Media package regression re-run green: tsx --test engine+a1111+comfyui+queue+video → 30/30; engine+queue tsx after list() → 9/9; engine/queue/comfyui tsc 0.
- Pending proof: device smoke ("generated image remains visible after reopen/update", preview/save/share through managed blobs) needs a device; transcript inline linking + app composition/nav wiring of MediaPanel + real backend construction = T092 integration.
## Next — Batch 5
- T091 persona media bindings, T092 integration.
## 2026-10-14 T091 Persona image prompts + workflow launch (IM-09, PE-09) — Implementation

- New `packages/personas/media/` (`@locallab/personas-media`; deps contracts + personas-bindings junctions): `resolvePersonaMediaBinding(profile, findWorkflow)` — first bound `workflowIds` entry wins; unbound → caller may use global; removed workflow → `missing` with honest "no other workflow was used" message (persona-bindings contract: nothing silently substituted); `personaMediaPatch(workflowId|null)` round-trips through the profile map (`PERSONA_MEDIA_SETTINGS_KEY`).
- New `packages/chat/media-hooks/` (`@locallab/chat-media-hooks`; deps media-engine + personas-media + jobs junctions): `ChatMediaTurn` {conversationId, assistantText, finalState, personaProfile}; `imagePromptFrom` derives prompt from first non-empty reply line (≤300 chars) without touching chat titles/history; `onChatTurnCompleted(turn, ctx)` — non-completed turns never reach the engine (canceled/failed → skipped), persona-bound workflow beats global default, missing binding skips with explanation (no substitution), then engine `requestGeneration(requestedBy:"chat")` applies auto-generate toggle / prompt review (draft = reviewable without history write). Image jobs are engine-side category "media" — independent from text streaming.
- Checks: `tsc --noEmit -p packages/personas/media` → 0; tsx --test → personas-media 4/4 (bound/unbound/missing/patch round-trip). `tsc --noEmit -p packages/chat/media-hooks` → 0; tsx --test → media-hooks 6/6 using REAL JobScheduler+MemoryJobStore+MediaJobService: completed turn queues with derived prompt; canceled/failed → zero backend calls and zero jobs; persona workflow name observed in backend snapshot (differs from global default); deleted binding → skipped + honest reason + zero jobs; autoGenerate off → suppressed; promptReview → draft stored, source assistant text untouched.
- Smoke criteria covered at TS level: "Persona-bound workflow differs from global setting" and "stopping text before completion prevents automatic image work" (both asserted above). Live-device/real-server variants pending T159C-class verification.
- Note: not gated by held T061 — hook consumes injected `personaProfile` + `findWorkflow`; arena bindings untouched.
## Next — Batch 5
- T092 integration (mobile composition wiring of media engine + nav + backends).

## T092 — Media integration wiring (mobile composition) — DONE (2026-10-14)

Feature IDs: ER-06 (media integration; device smokes pending).

Changed/added paths:
- packages/media/integration/ — NEW package `@locallab/media-integration` (package.json deps: media-engine, media-queue, media-a1111, media-comfyui, contracts; self-contained tsconfig matching the media-family pattern — no exactOptionalPropertyTypes in package's own project; src + test only). Junctions created: packages/media/integration/node_modules/@locallab/{media-engine,media-queue,media-a1111,media-comfyui,contracts}.
- packages/media/integration/src/index.ts — MediaServerConfigSchema {backend: comfyui|a1111|coreml, baseUrl}; SqliteMediaSettingsStore + SqliteMediaServerConfigStore (media_settings, media_server_config single-row tables); buildMediaBackend(config, deps{db, blobSink, fetchImpl?, socketFactory?, coremlBackend?, mimeType?}) → {ok,backend,backendId} | {ok:false,failure:TypedError-shaped}: unknown id → unsupported; coreml without injected port → unsupported naming iPhone; malformed/non-http URL → malformed; comfyui → RecoveringMediaBackend(ComfyUiMediaBackend) with SqliteServerJobLedger; a1111 → A1111Client/A1111MediaBackend. Core ML path is an injection seam: T088's device build passes the real CoreML MediaBackendPort as deps.coremlBackend; until then config.backend "coreml" yields a typed unsupported failure (distinct error path proven on Windows).
- packages/media/integration/test/integration.test.mts — 7 tests: settings defaults+persist+table; server-config round-trip + schema reject; coreml-no-injection unsupported /iPhone/; coreml-with-injection ok; unknown vs malformed distinct; comfyui builds wrapped in RecoveringMediaBackend and an unreachable server maps to typed "offline"; a1111 HTTP 404 on model discovery maps to typed host-stopped path (deep per-backend error fixtures stay in the adapter suites).
- packages/media/a1111/src/index.ts + packages/media/comfyui/src/index.ts — exactOptionalPropertyTypes-compat fixes so mobile (which extends tsconfig.base with EOPT) can consume them: conditional spreads in snapshotParams; `signal === undefined ? {} : { signal }` at api/fetch call sites; pollSignal/local-body hoist in txt2img. Behavior unchanged; adapter suites still green.
- apps/mobile/composition/media/providers.ts — NEW: createMediaRuntime({db, blobs, fetchImpl?}): opens SqliteMediaSettingsStore/SqliteMediaServerConfigStore/SqliteMediaReviewStore, createMobileJobScheduler + recover(), default server config {comfyui, http://127.0.0.1:8188}, buildMediaBackend with blobSink → BlobStore.importBytes (managed blob id = outputRef) and a React-Native WebSocket socketFactory for ComfyUI progress; on config/backend failure returns runtime.failure and the panel shows the message instead of a live service. MEDIA_DEVICE_ID constant for the job store.
- apps/mobile/composition/chat/navigation.ts — chatPageLabels gains media: "Image generation".
- apps/mobile/composition/chat/screen.tsx — media wiring: boot creates media runtime (createMediaRuntime({db: database, blobs})); runtime type gains media: MediaRuntime; setRuntime carries it; menu entry "media" (icon image-outline) after groups, hidden from beginner view like groups; panel branch renders MediaPanel (service/scheduler/settings/reviews + DEFAULT_MEDIA_WORKFLOW + runtime.conversationId) or the failure text; fall-through ChatPanels guard extended (panel !== "media").
- apps/mobile/node_modules/@locallab/{media-integration,media-a1111,media-comfyui} — junctions added (mobile package.json untouched per repo convention).
- apps/mobile/composition/chat/screen.tsx — transcript leg of step 1: after a completed assistant run (post event-loop; skipped on cancel/failure), calls onChatTurnCompleted({conversationId, assistantText: finalAssistant, finalState: "completed", personaProfile: identity.profile}, {service: runtime.media.service, defaultWorkflow: DEFAULT_MEDIA_WORKFLOW, findWorkflow resolving DEFAULT_MEDIA_WORKFLOW by name}) fire-and-forget with traceLog on rejection; persona-bound workflows therefore win over the default inside the hook, and prompt-review drafts land in media_reviews, never chat titles/history.
- apps/mobile/node_modules/@locallab/chat-media-hooks — junction added.
- apps/mobile/composition/media/providers.test.mts — NEW permanent test (vitest): full composition on real SQLite (node:sqlite port fake), comfyui default backend built ok, enabled auto-generation button request reaches scheduled job, unreachable server drives it to state "failed" with typed error containing "offline", then a fresh createMediaRuntime over the same DB reloads settings and lists the finished job (restart-reopen proof at TS level).

Commands + results:
- `node node_modules/typescript/bin/tsc --noEmit -p packages/media/integration` → 0 errors.
- `node node_modules/typescript/bin/tsc --noEmit -p apps/mobile` → 0 errors.
- `node node_modules/tsx/dist/cli.mjs --test packages/media/{engine,a1111,comfyui,queue,video,integration}/test/*.mts packages/personas/media/test/*.mts packages/chat/media-hooks/test/*.mts` → 46 pass 0 fail (media+persona+hook suites together; integration suite itself 7/7).
- `node node_modules/vitest/vitest.mjs run --root C:/code/cht apps/mobile` → Test Files 1 failed | 60 passed (61), Tests 437 passed (437). New file is composition/media/providers.test.mts; the 1 failed file remains the allowed platform/abort-compatibility.test.mts collection error.

Evidence levels:
- TS-level composition boot + settings persistence + job lifecycle + typed offline error + reopen-after-restart: PROVEN (providers.test.mts on real SQLite).
- MediaPanel ↔ service ↔ scheduler on the media tab: components unit-proven (T089) + wiring type-proven; on-device smoke NOT run (no simulator/device here).
- Deep backend error mapping (offline/host-stopped/missing-model/unsupported/malformed): adapters' fixtures + integration 7/7.

Pending proof:
- iPhone Core ML local image smoke — BLOCKED on T088 (Swift/CoreML native build, no Xcode/macOS/iPhone here); coreml injection seam + Windows-side error distinction proven.
- Real-server matrix (ComfyUI/A1111 live generation, restart artifacts on device) — device/server-blocked; list as device blocker per card.
- A persona-settings UI field for binding media workflowIds (personaMediaPatch exists; those screens are outside T092 owned paths) is a remaining TS-level surface for a later card.

Batch 5 media card order complete: T084✓ T085✓ T086✓ T087✓ T088(blocker)✓ T089✓ T091✓ T092✓.
Next: batch 6 — companion/sync starting T093 (frozen sync protocol; NOT the original product protocol).
## 2026-10-14 — T093 Pairing QR v1 crypto (batch 6) — DONE
Feature IDs: RE-01, RE-06. Card: plans/tasks/P09/T093.md.

Changed/added paths:
- packages/remote/crypto/package.json + tsconfig.json (new package @locallab/remote-crypto; self-contained tsconfig, no EOPT; junctions node_modules/@locallab/{contracts,service-contracts})
- packages/remote/crypto/src/index.ts (frozen KDF layout documented in header: HKDF-SHA256(32B secret, salt=mobileSalt||companionSalt, info "locallab-pairing-{hello|key|nonce}-v1|1.0|<routeId>[|<flow>]"); hello proof HMAC over transcript; nonce12 = HMAC-SHA256(nonceKey,"c:"+u64be(seq))[0..12]; AAD "v1|route|reqId|seq|tag|declared|nonce16"; AES-256-GCM ct||tag; SealingChannel/OpeningChannel with REPLAY_WINDOW=1000 + 64-bit seen bitmask; PairingQrV1 generate/encode/parse; mobileRouteTicketHash (relay stores keyed HMAC, never secret); PairingRecord + regeneratePairing rotating secret AND companionRouteId with revokedAt invalidation; hand-rolled createUuidV7 because @types/node 24 lacks randomUUID({version}) overload)
- packages/remote/crypto/scripts/generate-vectors.mts (deterministic fixture generator; payloadJson canonicalized via EncryptedPayloadSchema.parse + JSON.stringify so zod key-order canonicalization is shared cross-language)
- packages/remote/crypto/fixtures/pairing-vectors.json (FROZEN golden vectors: 2 direction keys, hello key/proof, ticket hash, 6 sealed frames seq 0/1/5 both directions)
- packages/remote/crypto/test/crypto.test.mts (8 tests: golden vectors reproduce every frame; round-trip both directions; replay "already used"/"below the replay window"/"beyond the replay window"; tamper -> authentication failed; foreign nonce -> nonce mismatch; 200 unique nonces; per-salt session scoping; hello proof positive/negative; QR fresh 256-bit secrets + strict parse rejection; regeneration revokes old pair and rotates route/secret/ticket)
- apps/companion/Cargo.toml (deps: aes-gcm=0.10.3, hkdf=0.12.4, hmac=0.12.1, sha2=0.10.9, subtle=2.6.1; dev: serde_json=1.0.145; Cargo.lock updated by cargo — npm pins/lock untouched)
- apps/companion/remote/crypto/mod.rs (Rust mirror: b64url codec (roundtrip-canonical), hex, HKDF, HMAC (Mac trait disambiguated), derive_* parity, derive_nonce, hello_proof/verify (constant-time via Mac::verify_slice), mobile_route_ticket_hash, seal_bytes (AAD binds declared_size=pt+16), OpeningChannel mirror incl. u128 bitmask window; 5 #[cfg(test)] tests read the SAME TS fixture via concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/remote/crypto/fixtures/pairing-vectors.json"))
- apps/companion/src/lib.rs (pub mod remote { #[path = "../../remote/crypto/mod.rs"] pub mod crypto; } mirroring runtimes pattern)

Commands + results (all at C:/code/cht):
- node node_modules/typescript/bin/tsc --noEmit -p packages/remote/crypto -> 0 errors
- node node_modules/tsx/dist/cli.mjs packages/remote/crypto/scripts/generate-vectors.mts -> "wrote fixtures/pairing-vectors.json 6 frames"
- node node_modules/tsx/dist/cli.mjs --test packages/remote/crypto/test/crypto.test.mts -> tests 8, pass 8, fail 0
- cd apps/companion && cargo test -> lib: 9 passed; 0 failed (incl. remote::crypto x5); bin/doc 0 — byte-identical ciphertext/nonce/declaredSize vs TS fixture for all 6 frames

Evidence level: cross-language golden vectors (TS->Rust same fixture, byte-exact), replay/stale/far-window rejection in both languages, tamper/foreign-nonce/declared-size/route mismatch fail-closed in Rust, duplicate/stale/beyond rejection in TS, nonce uniqueness + rotation non-reuse in TS. Key display/copy/edit UI deferred to T096 (regenerate/label API frozen here).

Bug caught mid-card: TS seal originally skipped setAAD while open required AAD (fixed: seal binds AAD with declaredSize=pt+16 before encrypt); Rust AAD initially used placeholder declared_size 0; fixture canonicalization (zod reorders event "type" key) — generator now stores parse()-canonical payloadJson so Rust byte-compares correctly.

Pending proof: RN/expo-crypto port of this KDF for the phone side of pairing UI (T096) — this package uses node:crypto. Relay-side registration/rotation transport semantics (route ticket hash storage, hello handshake over relay) -> T094/T103. QR code rendering -> T096.

Unaffected areas not re-run: apps/mobile (no import changes), media/service packages, contracts.
Next: T094 relay (read plans/tasks/P09/T094.md).
## 2026-10-14 — T094 Opaque WebSocket relay service (batch 6) — DONE
Feature IDs: RE-02. Card: plans/tasks/P09/T094.md.

Changed/added paths:
- services/relay/package.json + tsconfig.json (new package @locallab/relay; self-contained tsconfig incl. esModuleInterop (no EOPT, per packages/remote/crypto precedent); package-local junctions node_modules/@locallab/{contracts,service-contracts,remote-crypto} -> packages dirs, node_modules/ws -> root node_modules/ws (ws 7.5.13 hoisted, no @types/ws pinned))
- services/relay/src/ws.d.ts (minimal module declaration for ws 7.5.13: default export IS the client class with .Server static (v7 quirk: index exports class+Server+Receiver, NOT a "WebSocket" key); only members used declared; _socket documented as 7.x private handle)
- services/relay/src/index.ts (opaque relay: HTTP server + ws 7 Server(maxPayload=limits.maxFrameBytes); GET /healthz,/metrics,/release/version else 404; companion registers /companion?routeId&credential&mobileTicketHash -> relay stores sha256(credential)+keyed ticket hash ONLY (never the 256-bit pairing secret); mobile authorizes /mobile?routeId&ticket via mobileRouteTicketHash + timingSafeEqual; per-frame checks ONLY: JSON+EncryptedRelayFrameV1Schema strict parse, routeId match, protocol major/minor ceiling vs PAIRING_PROTOCOL, validateRelayFrameSize (declaredSize==ciphertext bytes), rate windows msgs/sec+bytes/sec, maxConnections, route TTL sweep, idle heartbeat ping/pong; sequence/replay intentionally delegated to peer-layer OpeningChannel — relay is stateless per frame; oversized ws 'error' -> oversizedMessages metric + clean 1009 client close; backpressure target.bufferedAmount>=highWaterBytes -> source._socket.pause()/target drain resume; audit ring cap 512 routing-metadata only; metrics counters incl. connectionRejections by reason; close() = Promise.withResolvers + terminate peers + wss.close + server.close + closeAllConnections (undici keep-alive otherwise wedges server.close forever))
- services/relay/src/cli.ts (env config RELAY_PORT 8790 etc., audit JSON to console, SIGINT/SIGTERM close)
- services/relay/Dockerfile + services/relay/docker-compose.relay.yml (node:26-slim, npm ci --omit=dev, node --experimental-strip-types cli.ts, non-root USER node, read_only + tmpfs /tmp compose, HEALTHCHECK fetch /healthz, env-exposed limits)
- services/relay/test/relay.test.mts (10 tests, node:test + global undici WebSocket client; slow-client test uses ws-module client with _socket.pause()/resume() to force real TCP flow control)

Commands + results (all at C:/code/cht):
- node node_modules/typescript/bin/tsc --noEmit -p services/relay -> 0 errors
- node node_modules/tsx/dist/cli.mjs --test services/relay/test/relay.test.mts -> tests 10, pass 10, fail 0 (clean process exit)
- CLI smoke: RELAY_PORT=8791 tsx services/relay/src/cli.ts -> "locallab relay listening on :8791"; fetch /healthz {"ok":true,...}, /release/version {"version":"0.1.0","protocolMajor":1,"protocolMinor":0}

Evidence level (unit-tested local smoke): both-direction sealed round trip recovers exact payloads via OpeningChannel; operator capture (audit ring + onAudit stream) contains NO plaintext/confession marker; wrong ticket, unregistered route, credential hijack -> close 1008, rejectedAuth>=3; malformed/route-mismatch/size-lie rejected (framesForwarded 0, companion queue 0); oversized >maxFrameBytes -> 1009 + metric, next small frame still forwards; rate limit closes spammer, forwards stop growing; companion reconnect keeps seq continuity (same OpeningChannel opens post-reconnect frame); TCP-paused slow client: backpressureEpisodes>=1, frames arrive stalled (<16 received) then all 16 in order undamaged after resume; expired route swept (TTL 400ms/sweep 100ms): both peers closed 1008, activeRoutes 1->0; health/metrics/version/404. Replay defense lives in the peer layer (T093 fixture-verified), NOT the relay — documented in module header.

Bug caught mid-card: short/malformed mobile ticket made mobileRouteTicketHash THROW inside connection handler -> whole relay process crashed (tests failed then hung waiting on dead sockets); fixed by try/catch -> treat as ticket rejection + defensive try/catch around acceptConnection. Also close() hang root cause: fetch keep-alive sockets keep server.close callback from firing -> closeAllConnections().

Pending proof: live deployed-relay + real device pairing smoke (T096 UI, T103 gate); Docker build not executed here (Docker sandbox blocked; Dockerfile/compose are definitions only); scale behavior of rate/TTL limits unmeasured.
Unaffected areas not re-run: apps/mobile (1 failed | 60 passed baseline stands — no imports touched), packages/remote/crypto, apps/companion cargo.
Next: T095 companion model routing (apps/companion/remote/routes, Rust; RE-03, RE-05).
## 2026-10-14 — T095 companion model routing and health (batch 6) — DONE
Feature IDs: RE-03 (remote LM Studio/Ollama/oMLX routing), RE-05 (backend-specific setup errors). Card: plans/tasks/P09/T095.md.

Changed/added paths:
- apps/companion/remote/routes/mod.rs (new std-only module: RoutingCargoError {kind: unconfigured|not_allowlisted|unreachable|stopped|malformed|io, message} preserving backend label in EVERY message (RE-05); BackendKind {Local,LmStudio,Ollama,OmLx} id()/label()/from_id() + per-kind health_path (/health, /v1/models, /api/version, /health) and chat_path (/api/chat for Ollama, /v1/chat/completions otherwise); validate_origin frozen shape http://<loopback>:<port> exact-origin-only (no path/query/credentials, explicit port, 127.x/localhost/::1) mirroring packages/providers/compatible-local rule; RouteRegistry::configure validates at configure time so resolve() can never touch arbitrary destinations (RE-03); BackendHealth {route_id,backend,ready,detail} + check_health/health_registry; raw HTTP/1.0 Connection:close client (CONNECT_TIMEOUT 750ms, READ_TIMEOUT 5s, head cap 64KiB); cancel_pair -> (CancelToken,CancelHandle) Arc<AtomicBool>; forward_chat_stream -> StreamOutcome{bytes_forwarded,cancelled}: status>=400 = stopped error naming backend+status, EOF before Content-Length fulfilled = "stopped mid-stream after N of M bytes" naming backend, cancel = Ok lifecycle with socket closed)
- apps/companion/src/lib.rs (mount: pub mod remote { routes } via #[path = "../../remote/routes/mod.rs"] alongside crypto)

Commands + results (at C:/code/cht/apps/companion):
- cargo test -> lib: 16 passed, 0 failed (9 prior baseline + 7 new remote::routes tests)

Evidence level (unit-tested local smoke; loopback fake HTTP backends on ephemeral ports):
- all_supported_backends_are_reachable_through_companion: local+LM Studio+Ollama+oMLX registry, health_registry all ready, all four labels present
- arbitrary_destinations_are_denied: example.com host, /v1 path, admin@ credentials, https scheme, missing port, 10.0.0.5 all rejected at configure with kind not_allowlisted + backend label in message
- unconfigured_route_is_denied_not_proxied: resolve("some-other-route") -> kind unconfigured
- down_backend_reports_named_setup_error: dead port -> ready=false, detail names Ollama
- stream_cancellation_is_clean_lifecycle: 4000-byte slow streamer, cancel after 60ms -> Ok(cancelled), 0 < bytes < 4000, completed well under READ_TIMEOUT
- server_stop_preserves_backend_identity: Content-Length 4000, backend writes partial then dies -> kind stopped, message contains "LM Studio" (mid-stream stop preserves backend identity per card smoke)
- refused_backend_status_is_a_named_stop_error: 503 from oMLX route -> kind stopped with "oMLX" and "503"

Bug caught mid-card: fake backends not draining the request body made Windows close() with RST, turning clean closes into read errors ("unreachable" instead of "stopped"); drain_request now consumes declared Content-Length (comment records the RST hazard).

Pending proof: live LM Studio / Ollama / oMLX machines (none installed here -> backend blocker, like prior device blockers); mobile-side route selection UI + chat-frame plumbing through relay into these routes = T096/T097/T102; T097 binary forwarding depends on this card.
Unaffected areas not re-run: mobile vitest baseline, tsc apps/mobile, services/relay, packages/* (no shared files touched).
Next: T096 mobile QR pairing and remote connection UI.

## T096 — Mobile QR pairing + remote connection UI (PL-07) — DONE (2026-10-14)

Scope: scanner/manual-key pairing state with project-owned QR validation + opt-in sharing; relay session connect with negotiated route capabilities; explicit version-mismatch / re-pair help; disconnect/revoke/rotation lifecycle.

Changed:
- `packages/remote/crypto/src/index.ts` — new export `deriveSessionSalts(pairingSecret, routeId)` (deterministic HKDF-SHA256, info "mobile"/"companion", 16-byte salts; per-pairing fresh on secret+route rotation); `createUuidV7` now exported; `parsePairingQrPayload` normalizes schema failures to `PairingCryptoError("malformed", …)` (no raw ZodError leaks to scan UI).
- NEW `packages/remote/client/` (`@locallab/remote-client`): sealed-frame pairing client (`createPairingClient`): relay auth via QR (mobile ticket), pairing-hello/ready handshake inside `EncryptedPayload` envelopes (relay stays opaque; secret never on wire), proof-echo verification (`helloProof`/`verifyHelloProof`), capability negotiation (`RouteCapability[]`), states `connecting|awaiting-peer|ready|closed|re-pair-required|version-mismatch`; vault lifecycle `storePairedDevice`/`revokePairedDevice`/`rotatePairedDevice`/`usablePairing`. Package-local junctions only (remote-crypto, service-contracts, relay).
- NEW `apps/mobile/features/remote/` (`index.ts` headless view layer, `screen.tsx` RemotePanel, `remote.test.mts`): RN-safe pure helpers (QR scan validation via project-owned `PairingQrV1Schema`, consent gate, paired-device rows, connection-state help text), engine injected as `PairingEngine` port. Junction added: `apps/mobile/node_modules/@locallab/service-contracts` (no package.json/lockfile change; mirrors media-engine junction precedent).

Wire contract (defined here, frozen): mobile→companion sealed `{tag:"request",body:{type:"pairing-hello",proof,protocol,client}}`; companion→mobile sealed `{tag:"request",body:{type:"pairing-ready",proof(echo),protocol,routes[]}}`; either side sealed `{tag:"close",reason}`. No service-contracts change needed (payload body is `z.unknown()`).

Evidence (live, this card):
- `tsc --noEmit -p packages/remote/client` — 0 errors.
- client suite `node node_modules/tsx/dist/cli.mjs --test packages/remote/client/test/client.test.mts` — 7/7 against a LIVE `createRelayServer`: pair + capability negotiation both directions; hello sealed on the wire (client field visible only after opening); version-mismatch state + fresh-QR note; bogus proof echo → `re-pair-required`; old/foreign QR (LM-MINI payload, v0 draft, garbage) rejected at construction (`PairingCryptoError`); stale mobile ticket → relay 1008 → `re-pair-required`; rotate → new route pairs fresh while OLD qr is rejected; revoke stamps + blocks.
- crypto suite — 9/9 (new test: derived salts deterministic, 16B, mobile≠companion, differ per route/secret, interop session round-trip).
- mobile: `remote.test.mts` 9/9; `tsc --noEmit -p apps/mobile` 0 errors; full mobile vitest — **Test Files 1 failed | 61 passed (62), Tests 446 passed (446)** (was 61 files/437; the one failure remains the known `platform/abort-compatibility.test.mts` collection error).
- companion cargo untouched by this card (baseline 16 passed stands).

Pending proof (recorded blockers):
- iPhone↔Mac real-device pairing smoke: no iOS device / no Mac host in this environment (same device blocker class as T081/T089/T092).
- Device crypto binding: `@locallab/remote-crypto` uses `node:crypto`; expo-crypto 57.0.3 has digest/random only (no HKDF/AES-GCM) → RN runtime needs react-native-quick-crypto-class module before `createPairingClient` can run on iPhone; the UI injects the engine port for exactly this seam.
- Companion-side responder (QR display UI + pairing-hello/ready responder + Rust `derive_session_salts` mirror) belongs to T102 (companion sharing/tray/startup); client tests use a scripted companion that follows the frozen handshake above.
- Rotation UX on device: UI `rotate` prop optional; full key rotation = desktop regenerates QR (`rotatePairedDevice` in @locallab/remote-client) — no official LM Mini interop is claimed or attempted anywhere in this flow.

Next: T097 (encrypted binary image/speech forwarding; deps T095,T093,T076,T086).

## T097 — Encrypted binary image/speech forwarding (RE-04, IM-12) — COMPLETE 2026-10-14

Scope: `packages/remote/binary` (new TS package: src/index.ts, test/binary.test.mts, ws.d.ts, package.json, tsconfig.json + package-local junctions), `apps/companion/remote/media/mod.rs` (new Rust engine), mount in `apps/companion/src/lib.rs`.

Design/wire: uses ONLY the frozen relay payload tags — `binary-start{transferId, mimeType 1..128, length int>=0, sha256 hex64}` / `binary-chunk{transferId, index, bytesBase64Url <= ceil(MAX_MEDIA_CHUNK_BYTES*4/3)}` / `binary-end{transferId}` (MAX_MEDIA_CHUNK_BYTES = 262144, service-contracts/src/relay.ts:10). Total bound 64 MiB on BOTH declared and observed bytes (`MAX_BINARY_TOTAL_BYTES` mirrored in Rust). Flow control: credit windows (`BinaryWindow`/`MediaWindow`) cap un-acked chunks; receiver credits via `binary-ack` bodies riding `request` envelopes (`binaryAckPayload`/`readBinaryAck`). Cancellation: `cancel` tag discards partial state; restart clean. Request/run identity: every sealed frame carries `requestId`; job association via RunEvent `MediaReference{runId,mediaId,mediaType}` at the composition layer (the strict `binary-start` schema has no runId field — identity lives at the sealing/composition layer). Step 3 (never convert binary to lossy text): bytes -> base64url (exactly lossless; test asserts the full 0..255 byte range and forced 0xFF runs) inside sealed ciphertext; no JSON-escaping or re-encoding anywhere in the route.

Fail-closed receiver semantics: gap (indices must be contiguous 0..n-1), truncation (bytes total != declared length at end), oversize (declared length / fat chunk / generator bound), sha256 mismatch, and cross-transfer frames ALL reject; duplicate chunk indices are idempotent ("duplicate") so slow-relay/reconnect redelivery never corrupts or duplicates.

Evidence:
- `node node_modules/typescript/bin/tsc --noEmit -p packages/remote/binary` -> 0 errors.
- `node node_modules/tsx/dist/cli.mjs --test packages/remote/binary/test/binary.test.mts` -> 9/9 pass: 300 KiB lossless round trip + checksum equivalence vs local output; base64url full byte range; duplicate-chunk idempotence; gap/truncation/tampered-checksum fail closed; oversize (declared, fat chunk, generator); cancel + restart; window credits with monotonic acks; binary-ack envelope round trip; LIVE-relay sealed transfer (assembled sha == local sha256 + dedup probe). Harness note: companion must register the route and mobile must be online BEFORE frames flow — the relay drops frames whose target peer is offline.
- `cd apps/companion && cargo test` -> 26 passed; 0 failed (16 baseline + 10 new media tests: known sha256("abc") = ba7816bf... vector; lossless round trip; duplicate chunks; gap + truncation; tampered checksum; oversize (declared/chunk/sender); cancel + restart; monotonic window; sender frame ordering (start, equal chunks, one end); empty transfer checksum e3b0c442...). Also fixed the pre-existing unused-`mut` warning in `remote/routes/mod.rs` `connect()`.

Pending proof / blockers:
- Live ComfyUI/Kokoro backend smoke from the card cannot run here: no ComfyUI/Kokoro backends installed on this host (same blocker class as T095's live-backend items). The local checksum-equivalence matrix plus the live-relay sealed transport test stand in.
- Job/status RunEvent streaming (runId association) and QR/pairing responder wiring land in the T102 companion service layer; device-side decode UI is the T076 mobile media feature consuming T102-forwarded `MediaReference` events.

## T098A — sync opt-in and initial-choice preferences (batch 6)

Feature IDs: SY-02 (per-pair sync switch), SY-03 (initial copy/merge choice at pairing), SY-07 (disabling retains local copies).

Changed:
- `packages/sync/preferences/` (new @locallab/sync-preferences v0.1.0; deps @locallab/contracts workspace:* + zod 4.1.12 pinned): src/index.ts — SyncChoice ("copy-phone"|"copy-mac"|"merge"), PairSyncPreference + SyncPreferenceRecordSchema (z.strict, routeId EntityId, choice nullable, initialSyncDone), SyncPreferenceVault port, parseSyncPreferenceRecords (corrupt vaults fail closed kind "malformed"), optInPairSync/optOutPairSync (re-enable keeps choice+initialSyncDone; opt-out on never-enabled throws kind "state"), setInitialSyncChoice (requires opt-in; re-choice after initialSyncDone throws "already recorded"), completeInitialSync, single gate `syncDataAllowed` = enabled AND choice recorded (the only gate T098C transport must consult), needsInitialSyncChoice, syncChoiceLabel, syncPreferenceViews rows. test/preferences.test.mts (node:test).
- `apps/companion/features/sync-setup/mod.rs` (new, mounted in src/lib.rs as `pub mod features { pub mod sync_setup; }` via #[path]): SyncSetupError kind "state"|"malformed" (rs-result-type pattern), SyncChoice CopyMac/CopyPhone/Merge with labels mirroring TS, PairSyncSetup + SyncSetupRegistry (BTreeMap; opt_in/opt_out/set_choice/complete_initial/allowed identical semantics to TS package), restart persistence via stable TAB-line codec to_text/from_text (route\ton|off\tchoice|-\tdone|pending; malformed/dup/unknown tokens reject kind "malformed"; "" → empty). 5 cargo tests.
- `apps/mobile/features/sync/` (new feature; junction `apps/mobile/node_modules/@locallab/sync-preferences → packages/sync/preferences`, mobile package.json untouched): index.ts re-exports package + syncChoicePreviews() (three SY-03 copy cards with plain-language previews incl. removal warnings), syncToggleNote (SY-07: "Chats are never deleted; both local copies stay exactly where they are."), syncFailureNote (SY-08 retry-by-toggle copy), initialSyncPromptVisible. screen.tsx SyncPanel: per-pair Switch "Sync chats with {label}", state line (choiceLabel · ready), initial-choice prompt block when opted-in without choice (previews + three choice buttons), note + failure surfaces; runInitialSync prop is the T098C seam (choice stays pending + failure note when it fails). sync.test.mts (vitest) 6 tests.

Evidence (2026-10-14):
- `node node_modules/typescript/bin/tsc --noEmit -p packages/sync/preferences` → 0 errors; tsx --test → tests 5 pass 5 fail 0.
- `cd apps/companion && cargo test` → 31 passed 0 failed (26 baseline + 5 sync_setup: restart round-trip exact equality, disable/re-enable keeps choice+initial_sync_done, stray ops fail closed, corrupt rows reject, labels).
- `node node_modules/typescript/bin/tsc --noEmit -p apps/mobile` → 0 errors; vitest sync feature 6/6; full mobile suite new baseline: Test Files 1 failed | 62 passed (63), Tests 452 passed (452) — abort-compatibility.test.mts collection error remains the single known failing file.

Pending proof: pairing-time prompt wiring into live pairing + device restart persistence on real storage lands with T098C composition/T102 companion QR/setup UI and the T103 integration gate.

## T098B — revisioned messages, folders and tombstones (batch 6)

Feature IDs: SY-04 (chats sync both ways, newest edit wins), SY-05 (folders/structure incl. covers), SY-06 (deletes propagate; tombstone beats equal-revision update).

Changed:
- `packages/sync/core/merge/` (new @locallab/sync-merge v0.1.0; deps @locallab/contracts workspace:* + zod pinned; junction @locallab/contracts): src/index.ts — MergeStore over SyncRecord|Tombstone (contracts/entities SyncRecordSchema/TombstoneSchema), ordering reuses `compareRevision` from @locallab/contracts/identity (wallMs→counter→deviceId); equal revision: tombstone ALWAYS beats update (both arrival orders converge); equal revision + equal identity + divergent payloads → deterministic winner = smaller canonical-payload digest (FNV-1a 64 contentDigest over canonicalJson sorted-key JSON; documented as non-trust-boundary — envelope integrity is the sealed transport's) + MergeConflict {winner/loser stable recordIds} reported, never resolved by rewriting IDs or inventing revisions; allowlist PAYLOAD_SCHEMAS conversation/message/folder (others throw kind "unsupported" — how settings/credentials/model records stay out); payloads validated (kind "malformed"); snapshot() sorted rows incl. recordId verbatim; CoverStager: content-addressed folder covers — stage() dedups members per entity key (newest revision wins) so reordered/duplicated staging collapses to one digest, applyCover(store, digest, at, stamp) applies members (copy/replace semantics) and tombstones uncovered live rows at cover revision `at` with deterministic id = entityId (replays collapse); empty cover / tombstone staging rejected.
- test/merge.test.mts (node:test) covers: reordered+duplicated batch convergence (deepEqual snapshots, stable recordIds), equal-revision tombstone precedence both orders, order-independent conflict winner + identical conflict pairs, cover content-addressing + idempotency + no-resurrection after reconnect replay of pre-cover batch, unsupported/malformed fail-closed, digest canonicality.

Evidence (2026-10-14): tsc --noEmit -p packages/sync/core/merge → 0 errors; tsx --test → tests 6 pass 6 fail 0. Two real convergence bugs caught by the smoke itself and fixed: cover digest previously hashed duplicate member rows (now dedup per key), and equal-revision update-vs-stored-tombstone branch initially favored the update (now superseded).

Pending proof: two-device live convergence + reconnect ordering run through T098C transport and T098 composition; device-level offline edit/delete/reconnect matrix at T103.

## T098C — live paired sync transport and retry (batch 6)

Feature IDs: SY-01 (chats sync over the paired connection), SY-08 (sync/connection failure surfaced to the user + retry after host wake).

Changed:
- `packages/sync/core/transport/` (new @locallab/sync-transport v0.1.0; deps @locallab/contracts + @locallab/remote-crypto + @locallab/service-contracts workspace:* + zod 4.1.12; junctions to all four incl. @locallab/sync-merge for the receiver-side test): src/index.ts — SyncTransport queues ONLY the frozen relay wire payloads (`EncryptedPayload` tag "sync-batch" ≤ MAX_SYNC_RECORDS_PER_BATCH=500, "sync-ack" {recordIds}); enqueue() validates every record against SyncRecordSchema|TombstoneSchema (throws SyncTransportError kind "malformed", nothing queued on failure) and consults the single `allowed()` preferences gate FIRST — a disabled pair NEVER queues or sends; composition injects the sealed send port (seal→relay happens above, transport never sees keys/plaintext off-device); window-of-one-at-a-time pump `sendPending()` with requestIds from createUuidV7 (pairing wire contract rejects v4 — T096 lesson), bounded per-batch retries (maxAttempts default 5, injectable delay — no node:timers imports so it bundles for RN), on exhaustion suspends with user-visible failure note (feeds mobile syncFailureNote copy) and stays suspended until wake() (host wake / Sync off-on toggle); at-least-once + resume cursor: a batch leaves the queue only when every record id is acked; cursor is monotonic; handleAck idempotent under duplicate/stale/reordered acks (Set of ids, head-only drain); syncAckPayload() receiver helper caps acks at the batch contract.
- test/transport.test.mts (node:test, 6 tests): 600 records → exactly 500+100 batches drained by acks with uuidv7 requestIds; disabled pair (enqueue 0, zero sends, status "disabled" note); dropped frames → 3 bounded attempts → "failed" state + non-empty note + resumeCursor keeps acked batch → wake() + healthy port resumes at cursor and NEVER re-sends acked batches; stale/duplicate acks no-op, window-of-one in flight, malformed frame ack throws; re-delivered frames dedup end-to-end through @locallab/sync-merge MergeStore (liveCount unchanged after double replay); malformed records never queued.
- Bug found and fixed by the smoke itself: first pump design spun forever resending an unacked head after a successful send (acks are async) → redesigned to single-pass window-one pump the composition re-invokes on ack timeout / reconnect / host wake.

Evidence (2026-10-14): tsc --noEmit -p packages/sync/core/transport → 0 errors; tsx --test → tests 6 pass 6 fail 0 (first run hung 180s exposing the spin bug above; killed + fixed). Card smokes both proven: dropped/reordered/duplicated frames resume idempotently; disabled pair never queues.

Pending proof: live relay/relay-sealed integration (real createSessionPairing channels + relay socket) lands with T098 composition + T102 responder; actual host-wake reschedule wiring is OS/host work recorded earlier as pending (T102/T103 device matrix).

## T098 — sync integration and two-device convergence gate (batch 6)

Feature IDs: SY-01..SY-08 (complete set for this bundle).

Changed:
- `packages/sync/core/composition/` (new @locallab/sync-composition v0.1.0; deps @locallab/contracts + @locallab/service-contracts + @locallab/sync-merge + @locallab/sync-preferences + @locallab/sync-transport workspace:* + zod 4.1.12; junctions to all five): src/index.ts — SyncEngine fuses T098A preferences + T098B merge + T098C transport into ONE host port: enable/disable/chooseInitial/runInitialSync mutate the vault through the T098A semantics and flip the transport's single allowed() gate; runInitialSync roles: source = merge→both, copy-phone→phone side, copy-mac→mac side; source re-enqueues its live store rows VERBATIM (stable recordId + stored revision reused, never rewritten), target replaces its local set by tombstoning its own rows at the choice wall time (strictly newer than any pre-existing revision so replacement wins regardless of arrival order, SY-06); noteLocalChange() = host seam for edits/deletes (gated by assertChangeAllowed BEFORE queueing, see merge change below); onFrame() dispatches sync-ack→cursor drain, sync-batch→store.apply fail-closed (allowlist) then acks applied ids, and IGNORES inbound frames while the pair is disabled; retryAfterWake() = host-wake/off-on-toggle seam (refresh gate, wake transport, re-pump); status()/conflicts() feed the mobile syncFailureNote UI.
- `packages/sync/core/merge/src/index.ts` hardening: new export assertChangeAllowed(change) — sender-side admission gate running the SAME parse + conversation/message/folder allowlist as apply() without touching state; MergeStore.apply now also enforce the allowlist for TOMBSTONES (previously only records were allowlisted — a "persona"/"model" tombstone could have entered an envelope).
- test/composition.test.mts (node:test, 7 tests, two in-memory devices phone+mac wired by fake opened-channel): merge choice convergence incl. identical-title different-id conversations coexisting + zero conflicts, live edit propagation (Mac sees new title), delete propagation (liveCount drops both sides), initialSyncDone recorded both sides; copy-phone: Mac set replaced (liveCount 0 post-target step) then converges to phone set only, delete propagates after replace; copy-mac mirror; disable: local edits NEVER queued (enqueue 0), zero frames crossed, peer never sees the row (rowFor null), local copies intact BOTH sides, re-enable retains choice + initialSyncDone (no re-prompt/re-copy); offline edits both directions → bounded retries surface "failed" state + non-empty note + pendingRecords kept → reconnect + retryAfterWake converge (live snapshots deepEqual, tombstone retained as payload-null row); SY-03 wall: model/preference/provider-connection records + persona tombstone all throw kind "unsupported" at noteLocalChange, secret key stuffed inside an otherwise-valid conversation payload throws "malformed" (strict schema), forged inbound model batch throws at onFrame with NO state change, zero frames sent, nothing queued; choosing before opting in / running before choosing throws kind "state".
- Bug caught by the gate itself: composition only allowlisted outbound at RECEIVE time — assertChangeAllowed export closes the enqueue hole (excluded records can no longer reach a queue or envelope even from a buggy host).

Evidence (2026-10-14): tsc --noEmit -p packages/sync/core/composition → 0 errors; tsx --test composition → tests 7 pass 7 fail 0; siblings re-run after the merge hardening: merge 6 + transport 6 → combined "tests 12 pass 12 fail 0". Card smokes: two-device offline edit/delete/reconnect and identical-title cases converge ✓; Mac+iPhone live-sync smoke path = the two-device fake-channel engine test ✓.

Pending proof: real sealed-channel + relay socket integration of this exact engine pair lands at T102 (companion QR/pairing-hello responder + wiring); device restart persistence and the live pairing prompt UI remain the previously recorded device blockers (T102/T103 matrix).

## T099 — selective Persona, photo and memory sync (batch 6)

Feature IDs: SY-10.

Changed:
- `packages/sync/personas/` (new @locallab/sync-personas v0.1.0; dep @locallab/contracts workspace:* + zod 4.1.12; junction contracts): src/index.ts — PersonaSyncSelectionSchema (routeId + personaIds + photos + memories + updatedAt, strict), PersonaSelectionVault (async load/save like T098A), selectPersonas/clearPersonaSelection (one row per route; malformed input → SyncPersonaError "malformed"; clear-without-selection → "state"), findPersonaSelection, parsePersonaSelectionRecords fail-closed. THE WALL: personaTierGate(selection, ctx)(entityType, entityId, payload) — persona: only selected ids; memory: payload-first scope rules (persona-scoped ⇒ scopeId selected AND memories flag; conversation-scoped ⇒ conversation already synced; global NEVER crosses = private user memory), tombstones fall back to live row then to localRowExists (deletion cannot leak content, must converge); attachment: only photoAttachmentId of a SELECTED persona AND photos flag, tombstones via localRowExists. selection null = tier fully closed. resolvePersonaBindings → per-reference resolved/unavailable/not-needed decisions for photo/model/preset (device-local voice/provider/key/model ids NEVER rewritten or copied; opaque ids resolve explicitly on target). parsePersonaTierPayload validates persona/memory/attachment payloads (extra keys like credentials rejected "malformed").
- `packages/sync/core/merge/src/index.ts`: MergeStore gains `extraTypes` ctor param (persona tier validates against persona/memory/attachment schemas; chat-tier assertChangeAllowed never consults it) + exported isChatTierType. Default store behavior unchanged (T098 suites re-verified green).
- `packages/sync/core/composition/src/index.ts`: SyncEngineOptions.personaGate? (entityType, entityId, payload)=>boolean consulted on BOTH seams — noteLocalChange now routes each record through private admit(): chat tier → assertChangeAllowed (SY-03 unchanged), anything else → personaGate (absent gate = unsupported throw, fail-closed before any queue/envelope); onFrame admits EVERY inbound record before store.apply (a peer cannot push persona-tier rows we never selected); runInitialSync liveSourceRecords filters persona-tier rows through the gate (unselected local data never leaves in an initial copy either).
- `apps/mobile/features/persona-sync/` (index.ts + screen.tsx PersonaSyncPanel + persona-sync.test.mts; junction to sync-personas; junction-only like T098A, no manifest edit): opt-in only offered while chat sync enabled; per-character switches + pair-level photos/facts flags (togglePersonaSelection keeps flags); bindingDecisionText/personaBindingNotes copy — unavailable binding says "not on this device. Pick a replacement here — nothing was copied over." and never echoes referenced content.

Evidence (2026-10-14): tsc 0 errors for sync/personas, sync/core/merge, sync/core/composition, apps/mobile. node:test: sync-personas 6/6; composition 8/8 (7 T098 + NEW persona-tier test: selected persona+photo+fact cross the fake two-device channel; non-selected character's memory and global memory rejected outbound kind "unsupported", FORCED inbound batch refused with NO store change; persona-fact tombstone propagates as payload-null row); merge 6/6 + transport 6/6 re-run green. Mobile vitest persona-sync 7/7; FULL mobile suite unchanged: Test Files 1 failed | 63 passed (64) (abort-compatibility = the one allowed collection error), Tests 459 passed (459) = baseline 452 + 7 new.
Card smokes: "Only selected characters and their allowed facts/photos transfer" ✓ two-device gate test; "credentials or nonselected private memory cannot cross the pair" ✓ outbound+inbound refusal in the same test + credential-key payload rejection (strict schemas).

Pending proof: wiring personaGate into the live companion/mobile engine pair lands with T102 pairing transport (same composition port, selection vault host-provided); photo BYTES ride the T097 binary channel at T102 host wiring — sync-batch persona tier carries attachment metadata rows (mimeType/sha256/byteLength) and the live host re-requests blobs; live device matrix at T103.

## T100 — Apple iCloud data synchronization (batch 6)

Feature IDs: SY-09.

Changed:
- `modules/icloud/` (new @locallab/icloud v0.1.0; deps contracts workspace:* + zod 4.1.12; junction contracts): the CloudKit private-container BRIDGE contract Apple builds implement — ICloudAccountStatusSchema mirroring CKContainer.accountStatus (available/noAccount/restricted/temporarilyUnavailable/couldNotComplete) + per-state Settings copy (ICloudAccountNotes; "sync stays off until you turn it on"), ICloudRecord (recordName `entityType:entityId`, payload null = tombstone, assetSha256 content-addressed, HLC revision reusing EntityIdSchema), ICloudChangePage (opaque cursor + more), ICloudBridge (accountStatus/fetchChanges/saveRecords/saveAsset/fetchAsset), ICloudError(kind account|transport|malformed), parseICloudPage/parseICloudRecords fail-closed, recordKey.
- `packages/sync/icloud/` (new @locallab/sync-icloud v0.1.0; deps contracts+icloud+sync-merge workspace:* + zod; junctions for all three): IcloudSyncAdapter — SAME entity/tombstone model as relay (reuses MergeStore.applyBatch HLC no-ops, toSyncChange maps cloud rows back to SyncRecord/Tombstone wire, revisionKey `wall:counter:deviceId` = cross-transport identity). Explicit opt-in (setEnabled; never automatic per privacy row), status() = off/unavailable(account)/ready(pendingUploads) — publish/fetch FAIL CLOSED with ICloudError "account" unless accountStatus === available. Echo prevention for simultaneous transports: noteLocalChange skips any revision already in `seen` (pushed OR pulled); fetch marks every pulled revision seen and deletes matching pending rows (crossed effects applied/conflict/superseded) — no cloud→device→cloud ping-pong, relay-delivered rows upload exactly once; same-row double edits before publish keep only the HLC winner (compareRevision). Photo assets: attachment rows carry sha256 → saveAsset/fetchAsset blob pairing via assetSource/assetSink host hooks. stageAllLocalRows = initial copy (opt-in only gate).

Evidence (2026-10-14): tsc 0 errors both paths. node:test 7/7: modules/icloud 3 (account notes exhaustive, page/record parse fail-closed, recordKey round-trip) + packages/sync/icloud 4 — (1) TWO simulated Apple devices through a simulated CloudKit private container converge offline edits (both-side edits resolve by HLC, offline create arrives) and deletes STAY deletes (tombstone payload-null on both) — card smoke "serializes and merges two simulated Apple device revisions" ✓; (2) simultaneous-relay echo test: relay-delivered row uploads exactly once, own upload fetched back = duplicate no-op (pulled 0, saves unchanged, savedRecordNames has exactly 1 entry for the row), both devices' liveRows identical; (3) fail-closed account states: noAccount → status unavailable + syncOnce rejects kind "account" + queueing safe + recovers after account returns (pushed 1, peer converges) + opt-out = total stop; (4) photo row crosses iCloud WITH asset bytes drained at receiver (extraTypes attachment store).
Full sync package regression re-run after merge/composition/personas changes: merge 6 + transport 6 + personas 5 + composition 8 = 25 pass 0 fail (this card touched no sync-core files; icloud is additive).
Card smoke "Real two-device offline edits and deletes" = T159D device milestone (recorded pending below).

Pending proof: real CloudKit native bridge (modules/icloud contract implemented by Apple builds at T159D — CKContainer/CKSyncEngine wiring, subscription/live-query push vs polling cursor), real two-device offline matrix = T159D, host wiring of adapter into the mobile sync stack (T102/T103), iCloud-vs-relay UI exclusivity copy lands with T102 companion/mobile settings wiring.

## T101 — iPhone-to-Mac USB transport (batch 6)

Feature IDs: RE-11.

Changed:
- `apps/companion/usb/frames/mod.rs` (new, registered in `src/lib.rs` as `pub mod usb { frames, session, guard }`): the ONE framing both cable sides speak — u32-BE length-prefixed payloads, cap = pairing crypto MAX_FRAME_BYTES (1 MiB); FrameDecoder reassembles arbitrary chunking; oversize declaration clears state and kills the channel; frame_to_json/frame_from_json bridge the sealed pairing Frame ↔ camelCase wire JSON (identical field names to the relay golden vectors, so crypto::seal_bytes/OpeningChannel replay windows + AAD binding run unchanged over the cable).
- `apps/companion/usb/session/mod.rs`: handshake — `usb-hello {side:"mobile", protocol:"locallab-usb-v1", routeId, proof}` / `usb-ready {…, proof echo, routes}`; proof = the SAME helloProof(secret, mobileSalt, companionSalt, routeId) as relay pairing (QR-paired devices authenticate over USB with zero new secret material; secret never on the wire; forged proof AND unknown route both map to "unauthorized" so a probing cable learns nothing; stale protocol → "version-mismatch"). UsbPairingRecord = vault view of a pairing.
- `apps/companion/usb/guard/mod.rs`: ModeGuard — exactly one live session per pairing (remote XOR usb; same-mode re-claim idempotent for cable-wobble resume; stale release from a dead remote socket cannot evict a fresh USB session); UsbDeviceTracker cable state machine Unattached→Untrusted/Trusted→Active (untrusted cable can NEVER go Active) with ui_note() copy the Mac companion UI renders at T102.
- `modules/usb/ios/` (new @locallab/usb-ios v0.1.0; deps remote-crypto workspace:* + zod; junctions; fixtures/usb-frame-vectors.json SHARED with the Rust tests via CARGO_MANIFEST_DIR join — same precedent as pairing-vectors.json): iPhone-side mirror — encodeFrame/FrameDecoder (byte-identical), buildUsbHello/verifyUsbHello/verifyUsbReady (zod strict; verdicts authenticated|version-mismatch|unauthorized|malformed), ModeGuard + UsbDeviceTracker phone-side mirrors (relay reconnect refused while USB live), Trust/copy for the iPhone UI.
- `apps/companion/Cargo.toml`: serde_json "=1.0.145" moved dev-dep → regular dep (already pinned in Cargo.lock; needed by usb session/framing in lib src).

Evidence (2026-10-14): `cargo test` in apps/companion = 43 passed, 0 failed, ZERO warnings (31 baseline + 12 new usb:: tests): golden frame vectors byte-identical to the TS fixture (encode+decode both directions), fragmented delivery reassembly, oversize kills channel, empty frame; handshake authenticates with the PAIRING golden vectors (same proof value as pairing-vectors.json helloProofBase64Url), forged proof + unknown route + stale protocol fail closed, and a full sealed-plane proof: mobile seals a chat frame with derive_session_key/seal_bytes → encode_frame → FrameDecoder → frame_from_json → OpeningChannel open succeeds and exact replay is REFUSED (identical crypto over the cable). `tsc --noEmit -p modules/usb/ios` clean; `tsx --test modules/usb/ios/test/usb-ios.test.mts` = 7/7 incl. built hello proof EQUALS the pairing vector proof, tamper/unknown-route/version-mismatch verdicts, exclusivity both directions, cable state machine.
Card smoke "USB transport ports compile and enumerate a trusted device in a development setup" = both ports compile (cargo lib build in test + tsc) + trusted-device enumeration is the tracker state machine (attach(false)→Untrusted, trust_granted→Trusted, only-then Active); Windows dev box has no usbmuxd, so this is the verifiable depth here.

Pending proof: native macOS usbmuxd/CoreDevice enumeration + real attach/detach events (T159D device milestone — the Rust tracker consumes those events verbatim), physical unplug mid-session and Wi-Fi-disabled phone-to-Mac chat over a real cable (T159D; the sealed-plane test proves the crypto/framing path end-to-end in both languages), Mac companion UI wiring of guard/tracker copy lands at T102.

## T102 — Companion sharing / tray / startup UI (RE-07, RE-10, UI-15) — DONE 2026-10-14

Owned paths (per card): `apps/companion/features/sharing/mod.rs` (NEW), `apps/companion/lifecycle/mod.rs` (NEW); registered in `apps/companion/src/lib.rs` (`features::sharing`, `lifecycle::service`).

- **features/sharing** (UI-15 menu-bar sharing service): `PairingQrInput` + `create_pairing_qr_payload`/`parse_pairing_qr_payload` mirror `PairingQrV1Schema` from `packages/service-contracts/src/pairing.ts` — canonical key order {protocol{major:1,minor}, companionRouteId, relayUrl, mobileRouteTicket, pairingSecret, serverIdentityFingerprint}; strict fail-closed validation (43-char b64url32, `sha256:`+64-hex fingerprint, ws(s) relay, 36/32-hex route id, exactly-6-keys, major==1) so a foreign v2 or corrupt payload can never be re-broadcast. Raw secret/ticket material is injected by the host (no rand dependency; deterministic tests). `TrayCommand` (9 stable ids: open/start/stop/show-qr/health/keys/routes/voice-packs/quit) + `TraySurface` gating: ShowPairingQr only while sharing AND a live pairing QR exists (rotation replaces, revoke clears → handle Err "state"), health/keys/routes only while sharing, Quit always; `handle` validates against `available_commands`. `set_health_snapshot` renders "label: ok|not reachable" lines for the tray.
- **lifecycle** (RE-07 tray/auto-startup, RE-10 compatibility): `LifecycleSettings{start_at_login=false,opt-in, keep_sharing_on_close=true default}` bit-row store fail-closed on unknown keys/bad bits; `LifecycleMachine.handle(event, local_version)` → effects. Card smoke line 1: WindowClosed with keep-sharing → `ContinueSharingInTray` (service stays enabled); `QuitRequested` → `StopAll` ALWAYS even with keep-on-close; keep=false → close emits `StopSharing`. Card smoke line 2: Sleep→Wake → `Reconnect` exactly once (no phantom wake reconnect). `version_verdict` mirrors TS `assertProtocolCompatible`: same major + peer.minor ahead → `MacNeedsUpdate` prompt; major mismatch → prompt naming the behind side ("Update LocalLab Connect on this Mac" vs "Update the iPhone app"); incompatible prompts persist per route (`incompatible_prompt`) until a compatible re-handshake clears them. `toggle_start_at_login` → `SetLoginItem(bool)` effect for the native launch-at-login API.
- serde_json moved dev-dep→dep (`=1.0.145`, lock unchanged) in `apps/companion/Cargo.toml` (T101 record covers the move; QR payload JSON needs it too).

Verification: `cargo test` (apps/companion) = **55 passed, 0 failed, ZERO warnings** (43 T101 baseline + 6 sharing + 6 lifecycle). Both card smoke lines covered by lifecycle tests; QR strictness incl. off-by-one secret and foreign-v2 rejection covered by sharing tests.

Pending for native shell (T159D-class milestones, not this card): wiring these effects into an actual NSStatusItem menu + login-item API, rendering the QR payload string to a bitmap, and voice-pack engine wiring belongs to RE-08/RE-09 cards — the tray surfaces `ManageVoicePacks` as an OpenPanel entry point only.

## T103 — Remote, USB and sync integration gate (ER-07) — DONE 2026-10-14

Owned paths per card, all landed: `packages/remote/integration` (NEW package `@locallab/remote-integration`), `apps/companion/composition/remote` (NEW Rust module, registered in `apps/companion/src/lib.rs` as `composition::remote`), `apps/mobile/composition/remote` (NEW TS composition layer).

- **packages/remote/integration** (the gate itself): `src/index.ts` — `attachRemoteSession` (seals with UUIDv7 requestIds; open failures route to onError, never crash; best-effort sealed close), `streamChat`/`respondToChat`/`cancelChat` over the card's chat body contract (`{type:"chat-request"…}` → `tag:event` RunEvents → `chat-complete`; `tag:cancel`), `sendBinary` (remote-binary frames), `syncOneConversation` (SyncTransport→awaited ack-drain promise, rejects on sealed `sync-refused`), `ackSyncBatch` (gate-refusal never acks rejected records — fail-closed), `validateFrameOpaque`, `recordingSocket` replay seam; `src/ws.d.ts` repo-convention shim. **Invariant documented:** one session channel object per side MUST span handshake AND traffic — replay/sequence state lives in the channels; a fresh channel restarting at sequence 0 trips the peer's 64-slot replay window.
  7-test real-relay gate: real `createRelayServer` + real `createPairingClient` reaching `ready`; chat round-trip + DOUBLE-replay rejection; 700 KB xorshift binary through the relay (sha256 match, ≥5 frames); sync of one conversation (3 records → `MergeStore.liveCount()===3`, transport idle/pending 0, companion-redelivered ack absorbed idempotently); refused sync gate → `sync-refused` + `liveCount()===0`; declaredSize mismatch + ciphertext tamper → `PairingCryptoError`; **relay opacity asserted** — audit ring + metrics JSON contain zero chat/sync/runId sentinels while framesForwarded > 0. Relay semantics learned: frames are DROPPED for offline peers (companion must register before mobile connects) and never echoed back to the sender.
- **apps/companion/composition/remote** (Rust): `RemoteComposition{guard,registry,sync_setup}`; `session_opened(mode, route_id, remote_version_minor)` refuses kind "version-mismatch" before claiming, ModeGuard "excluded" passes through (USB-active blocks Remote claim and vice versa); `serve_chat` opens the sealed request frame (contentTag must be "request"), refuses kind "unconfigured" when body routeId ≠ session routeId (session route can never be steered to another registry entry), forwards via routes::forward_chat_stream to a configured backend, seals backend bytes back as an "event" frame; `sync_gate` accepts ONLY `enabled && choice.is_some() && initial_sync_done` (stricter than allowed() — a live-session batch is a data release), else Refused. Test proven via pairing-vectors.json-derived keys + loopback fake backend + mobile-side re-open of the response.
- **apps/mobile/composition/remote** (TS): `RemoteSessionPort` structural port; `createRemoteChatConnection` streamRun/cancelRun (runId filters events; cancel reason carries runId since strict cancel schema); `photoUploadPort` validates sha256 param (camera pipeline owns digest; no node:crypto in app code), encodes EACH chunk independently (unaligned chunk boundaries must decode per-frame like companion BinaryReceiver); `remoteSyncPorts` glue against real SyncTransport (direct `SyncSendPort` import after constructor fix); `remoteConnectionGuarded` blocks revoked pairs. 10 vitest tests.
- **Cross-cutting fix (outside owned paths, justified):** `packages/sync/core/transport/src/index.ts:103` constructor violated exactOptionalPropertyTypes for strict consumers (`onStatus: options.onStatus`); conditional spread now. sync-transport suite 6/6 green after.

Verification (all re-run at tip by me): `cargo test` = **59 passed zero warnings**; integration `tsc -p` clean + tsx **7/7** deterministic exit; `tsc -p apps/mobile` clean; mobile composition **10/10**; FULL mobile vitest = **65 files, 469 tests passed** (baseline advances 64/459 → 65/469; the single allowed failing file abort-compatibility unchanged); all sync tsx 34/34; usb-ios 7/7.

Pending for T159D (explicit, per card step 3): real off-LAN cellular pairing, device sleep/wake resume with USB re-hello, rotation timing matrix, physical USB cable + Apple camera-framework transport, iCloud Drive service-backed adapter runs, and the hostile-network deep matrix (relay under MTU/churn/DoS limits). Contract fixtures for all of these already exist in-tree (pairing-vectors.json, usb-frame-vectors.json, icloud adapter suite).

## T104 — Native theme editor and per-chat appearance (UI-01, UI-03, UI-04) — DONE 2026-10-14

Owned paths: `packages/themes/schema` (NEW package `@locallab/themes-schema`), `apps/mobile/features/themes` (NEW `index.ts` store layer, NEW `theme-editor.tsx`, `provider.tsx` extended). One consumer touch outside owned paths: `apps/mobile/features/chat-settings/screen.tsx` — "Customize theme…" button + provider sheet mount (integration trigger).

- Schema package: ThemeV1/AppearanceOverrideV1 strict zod imports (version literal 1, `.strict()` unknown-key rejection, lowercase #rrggbb, id regex, out-of-range numbers REJECTED not clamped on imports), `clampControls` (0.8..2.0 fontScale, 0..0.6 dim) for live paths, `resolveAppearance` override merge never throwing (unknown themeId silently keeps theme), builtins builtin/light/dark. 14 tsx tests.
- Store (`createThemesStore(SQLiteDatabasePort)`): `theme_state(scope PRIMARY KEY, doc)` with scope `global` vs `chat:<id>` (per-chat persisted SEPARATELY; clearing override deletes only its row), `custom_themes(id,doc)`; EVERY stored doc re-validated through the strict import validator on read (corrupt row → silently skipped/fallback builtin; chat decode → null); builtin ids guarded on save/delete.
- Provider: loads store once, repaints PaperProvider via `applyThemeV1` (palette + bodyLarge/bodyMedium scaled; forged scale re-clamped so max font keeps controls readable), exposes themeId/customThemes/saveCustomTheme/deleteCustomTheme/setChatOverrideFor/chatAppearanceFor (resolveAppearance per chat), MOUNTS the editor sheet (openThemeEditor/closeThemeEditor); strictly additive to existing themePreference/layout contract.
- Editor (`ThemeEditorSheet`): chip chooser builtins+customs, custom theme id/name/palette hex fields + scheme, fontScale steppers (0.1 clamp), bubble style, gradient on/off + from/to/angle (validated live), dim stepper, avatar size/placement, live preview (gradient bar, avatar circle, scaled bubble), import textarea routed ONLY through parseThemeImport/parseOverrideImport (invalid JSON → reason text, never crash), export selected, per-chat mode with "Use global appearance" reset.
- Notes: taken over mid-flight from cancelled slice agents (fixed broken import block, minLines RN prop, added missing test suite). Provider↔editor import cycle is render-time-only (safe lazy CJS interop pattern).

Verification (run by me at tip): schema `tsc -p packages/themes/schema` clean + tsx **14/14**; mobile `tsc -p apps/mobile` clean; `vitest run apps/mobile/features/themes` **7/7**; FULL mobile vitest = **66 files, 476 tests passed** (baseline 65/469 → 66/476; still exactly the ONE allowed failing file abort-compatibility); smoke: changing one chat leaves global defaults intact (1.2 untouched; resolved 2.0 clamped), invalid import rejected with reason, forged fontScale clamps to 2.0.

Pending (external/later): bundling licensed third-party font/art ASSETS (fontChoice currently maps to system families; gradient/dim are procedural — no unlicensed assets added) — asset licensing prerequisite; transcript bubbles consuming chatAppearanceFor in composition/chat screen (device visual milestone); alternate app icons belong to T120.

## T120 — Appearance behavior: glass, low-battery profile, full-width replies, iOS icons (UI-05, UI-06, UI-07, UI-08) — DONE 2026-10-14

Owned paths: `packages/appearance/behavior` (NEW `@locallab/appearance-behavior`), `apps/mobile/features/appearance-behavior` (NEW), `modules/app-icons/ios` (NEW `@locallab/app-icons-ios`), `apps/mobile/assets` (NEW icon variants). Consumer touches: `apps/mobile/app/_layout.tsx` (mount AppearanceBehaviorProvider with RN battery source), `apps/mobile/app.json` (`ios.supportsAlternateIcons: true`), `apps/mobile/features/chat-settings/screen.tsx` (renders AppearanceBehaviorSection).

- Behavior package (pure): `AppearanceBehaviorV1` strict zod import + `DEFAULT_APPEARANCE_BEHAVIOR` (glass on, low-battery auto, full-width replies DEFAULT ON per "later default"), `lowBatteryActive` (auto = unplugged & level ≤ 0.20 with known reading; on/off overrides), `effectiveEffects` (reduced overrides glass), `plainStreamEnabled`, `createDeferringSendPort` FIFO sync gate (defer buffers, resume flushes ONE snapshot batch so re-armed deferral never re-sends, pendingCount observable). tsx 6/6, tsc clean.
- Mobile feature: `createAppearanceBehaviorStore` (single `appearance_behavior(scope,doc)` table, strict import both directions, corrupt row → defaults), `createBehaviorController` (settings+battery state machine auto-defer/resumes all registered gates — recovery flushes deferred sends = deferred-sync-completion), `BatterySource` port + `reactNativeBatterySource` (feature-detects NativeModules.Battery via NativeEventEmitter, inert fallback), `AppearanceBehaviorProvider` + `useAppearanceBehavior`, `AppearanceBehaviorSection` UI (glass Switch, Low battery Off/Auto/On SegmentedButtons, full-width Switch; testID appearance-behavior-section). vitest 4/4 incl. deferral end-to-end (queued sends flushed in order after battery recovery).
- Icons: controller over an `AppIconBridge` port (default→null alternate name, dark/glass names, ineligible-device refusal without bridge call, unknown-name guard, native-refusal surface). tsx 6/6. Assets: `locallab-icon-dark.png` (HSV value ×0.45, sat ×1.15) + `locallab-icon-glass.png` (brightened + top-lift gradient feel) generated from the shipped `locallab-icon.png` via correct PNG unfilter/re-filter/zlib re-encode; all three files parse back with identical dims 1254² and mean-value shift verified (0.758 → 0.341 / 0.901). `supportsAlternateIcons` enabled in app config.

Verification (mine, at tip): packages/appearance/behavior tsc clean + tsx 6/6; modules/app-icons/ios tsc clean + tsx 6/6; `tsc -p apps/mobile` clean; FULL mobile vitest **67 files, 480 tests passed** (baseline 66/476 → 67/480; still exactly the ONE allowed failing file abort-compatibility).

Pending (device/consumer): Xcode asset-catalog registration of dark/glass + RN native bridge calling UIApplication setAlternateIconName (icon toggle on eligible iPhone — iOS build milestone); visual application of the effects tier (backdrop blur), plain-stream rendering, and full-width assistant reply layout in transcript/composition consumers (flags + defaults shipped, consumers not yet touched); junction hygiene note: an accidental rmdir of the `@locallab/schema` junction during this card was detected by tsc and recreated.

## T108 — Mobile PIN and biometric App Lock (DA-05, DA-06, DA-07, DA-08, DA-09, UP-06) — DONE 2026-10-14

Owned paths: `modules/app-lock` (NEW `@locallab/app-lock` core), `apps/mobile/features/app-lock` (NEW). Consumer touches: `apps/mobile/app/_layout.tsx` (AppLockProvider mounted between AppearanceBehaviorProvider and DiagnosticsProvider — gate overlay renders above the whole navigator), `apps/mobile/features/chat-settings/screen.tsx` (`<AppLockSection />` after the appearance section). Junction `apps/mobile/node_modules/@locallab/app-lock` → `modules/app-lock`.

- Core (pure, ports): `validatePin` exact 4/6 digits; `createLockRecord`/`verifyPin` salted digest via `HashPort` (random 16-byte salt per record, constant-time-ish compare, algorithm-labeled records); DA-06 grace enum (immediate/15s/1/5/15m/1h) + `shouldChallengeOnForeground`; `createLockSession` state machine — cold start always challenges, background/foreground grace gate, wrong PIN keeps gate closed, biometric success stays unlocked while cancel/error keeps it locked (`biometric-cancelled`), disable requires current PIN proof, `RecoveryPort.verifyToken`-gated authenticated recovery (no port → no bypass), entitlements consulted only for NEW enables — the gate survives Pro lapse and stays enforceable. tsx **10/10** (one test-flow fix: grace-expiry only re-challenges from unlocked state; cold-start lock persists through a within-grace foreground — correct security semantics).
- Mobile: `adapters.ts` — verifier lives in **expo-secure-store (Keychain)**, structurally never walked by sync/backup (DA-07), corrupt blob → null; `expoSaltedHashPort` (expo-crypto SHA-256, `Crypto.getRandomBytes` salt). `index.ts` — `app_lock_prefs(scope,doc)` table, grace round-trip with defaults fallback (variadic sqlite binds, `execAsync` schema). `provider.tsx` — `AppLockProvider` boots session from Keychain (coldStart challenge), `AppState` listener maps background/inactive→backgrounded, active→foregrounded(grace); `LockGate` full-screen overlay (testID app-lock-gate) with 12-key PIN keypad, masked display, status line, biometric button only when available; `section.tsx` — enable (PIN + confirm + match), 6 grace buttons, disable and change-PIN both gated on current PIN input, error message row. vitest **2/2** (prefs round-trip incl. corrupt/unknown-grace; stored grace drives gate end-to-end).

Verification (mine, at tip): modules/app-lock tsc clean + tsx 10/10; `tsc -p apps/mobile` clean; FULL mobile vitest **68 files, 482 tests passed** (from 67/480; still exactly the ONE allowed failing file abort-compatibility).

Pending (device/external): biometric OS prompt wiring — `BiometricPort` implemented/tested but the RN adapter needs `expo-local-authentication` (new npm dep, not installed per no-lockfile constraint; provider accepts `biometric` prop, gate hides the button until available); "successful biometric does not bounce back / cancel keeps locked" + "challenge on cold start / grace expiry" are device smoke rows (logic covered by the core tests); emailed account-assisted PIN recovery link (UP-06) is a hosted-service later item — the authenticated recovery port + token contract is in place; KDF hardening beyond single-pass salted SHA-256 (Keychain already holds the verifier out of sqlite; noted in adapters comment); entitlement enforcement at setPin currently defaults open until T107 ships the entitlements store.

---

## T110 — Encrypted cloud backup (DA-03) — COMPLETE 2026-10-14

Card: `plans/tasks/P10/T110.md` ("Customization and services", batch 7).
Parity row DA-03: "Optional encrypted cloud backup | Passphrase chosen by
user; Pro."

### What shipped
**Core `@locallab/backup` (`packages/backup`)** — schema-versioned envelope:
`LLBKP1\n` magic + uint32BE header length + header JSON (Argon2id KDF params:
64 MiB/3/2/32 defaults; AES-256-GCM iv/tag) + AEAD ciphertext with the magic
bytes as AAD (magic tamper fails auth too).
- `createBackup`: passphrase ≥ 8 chars; **credential-path refusal**
  (`keychain|credential|token|secret|password|pin|applock|app_lock` regex on
  entry paths → throws before any encryption, step 3); manifest entry
  (`manifest.json`, `BACKUP_SCHEMA_VERSION = 1`) injected into the zip;
  entries sorted by path.
- `openBackup`/`previewBackup`: header gate (version + argon2id +
  AES-256-GCM only), GCM tag verified **before anything is applied**, manifest
  `schemaVersion` gate rejects foreign versions.
- `applyRestore(zipBytes, RestoreTransaction{begin,stage,commit,rollback})`:
  failure → rollback + rethrow; nothing partially overwritten.
- zip handled through `setBackupZipPort` (host injects; tests inject a
  JSON-store double).
- `src/node-crypto.ts`: `nodeBackupCrypto()` = node:crypto AES-256-GCM +
  **Argon2id via `@noble/hashes/argon2`** (pure JS, already in root
  node_modules 1.8.0 — no new deps; satisfies the card's Argon2id step).
- Tests: `packages/backup/test/index.test.mts` — **7/7** via root tsx
  (round-trip + preview sorting, salt/iv uniqueness per run, wrong
  passphrase + ciphertext tamper + header byte flip, credential refusal with
  exact path report, transaction rollback log `["begin","stage:4","rollback"]`,
  hand-sealed schema-99 envelope refused, short passphrase refused).
  (Tests use 1 MiB/1/1 KDF for speed; production defaults 64 MiB/3/2.)
- tsc (`-p packages/backup`) clean. Junction
  `packages/backup/node_modules/@locallab/archives` → `packages/archives`.

**API (`services/api/features/backup`)** — ciphertext-only object store over
HTTP (server never decrypts; passphrase never transmitted):
`PUT/GET/DELETE /backup/objects/:id`, id gate `[a-z0-9][a-z0-9-]{7,63}` →
400, empty body → 400, > 512 MiB cap defined, missing → 404; default
`memoryBackupStore()`. Routes are standalone-registration like sandbox/search
(not mounted into `src/index.ts` — hosted territory, same convention).
`backup-route.test.ts` **4/4** via root tsx: byte-for-byte round-trip,
404/delete semantics, malformed-id + empty rejection with nothing stored,
opaque payload stored as-is (server never interprets).

**Mobile (`apps/mobile/features/backup`)**:
- `db-snapshot.ts`: whole-database snapshot from `sqlite_master` (table-name
  whitelist `^[A-Za-z0-9_]+$`), blobs ↔ base64 (no Buffer dependency),
  `snapshotCounts` (chats/personas/attachments); `restoreTransaction`:
  every DELETE/INSERT inside one `withTransactionAsync` → failure leaves db
  untouched; `toBindValue` coerces JSON values to `SqliteBindValue`.
- `client.ts`: `createBackupClient({db, crypto, store?, zip?, kdfParams?})`
  (create → preview → upload; download → open → transactional apply);
  `fetchBackupObjectStore(baseUrl)` → the API routes above.
- `provider.tsx`: `BackupProvider` (crypto port + store URL injected;
  without a `cryptoPort` the client is never built and the section shows an
  honest "encryption not available on this build" notice — Hermes has no
  AES-GCM primitive yet, see pending).
- `section.tsx`: passphrase + object id inputs, "Back up now" / two-step
  "Restore from cloud" (error-colored confirm), last-preview summary, error
  line; testIDs `backup-*`.
- Mounted: `BackupProvider` inside `AppLockProvider` in `app/_layout.tsx`;
  `<BackupSection />` after `<AppLockSection />` in
  `features/chat-settings/screen.tsx`.
- `backup.test.mts` (vitest) **5/5**: snapshot entries sorted per table,
  full create→upload→download→restore round-trip through the **real**
  `mobileArchiveZip` port (blob byte fidelity), wrong passphrase rejects with
  db untouched, ciphertext tamper rejected, failing INSERT rolls the whole
  restore back (FakeDb `withTransactionAsync` restores deep copy on throw).
- Junction `apps/mobile/node_modules/@locallab/backup` → `packages/backup`.

### Gates at tip
- `tsc -p packages/backup` clean; tsx 7/7.
- services/api backup routes: tsx 4/4.
- `tsc -p apps/mobile` CLEAN.
- mobile vitest full run: **68 passed files + the one allowed
  abort-compatibility collection error; 487 tests passed** (baseline 482 + 5).

### Pending (not blocking the card's checks)
- **Mobile client-side cipher primitive**: Hermes lacks AES-GCM; shipping the
  real device flow needs a native crypto module (dep forbidden in this
  batch) — argon2id itself runs in JS but at production parameters needs
  on-device timing. Provider/section degrade to disabled state meanwhile;
  core + client + restore logic already covered on the Node side of the
  mobile test env.
- Device smoke rows (create on device → restore on a clean install; wrong
  passphrase UX) once the native crypto port lands.
- KDF hardening review (mobile-appropriate Argon2id parameters).
- Hosting/auth for the object routes (account gate = Pro, per DA-03) once
  T107 entitlements land.


---

## T107 — Entitlement policy and preview gates (AR-08) — COMPLETE 2026-10-14

Card: `plans/tasks/P10/T107.md` (batch 7). Owned path: `packages/entitlements`.

### What shipped
**`@locallab/entitlements` (`packages/entitlements`)** — pure TS, no deps:
- **Build modes as distinct states (step 1)**: `mode: "dev" | "release"`.
  Dev = all-enabled with no receipts at all (verified by test); release =
  store-backed verified state.
- **Free/Pro matrix (step 2)**: `ProFeature = appLock | cloudBackup |
  groupChat | arenaCustomPrompts | arenaCloudContestants | arenaHistory |
  remotePairing` (mirrors AR-08, DA, GR, RE rows). Core local chat, personas,
  LAN sync and models are `CoreFeature` — NOT type-able gate targets
  (step 3's "without gating core local/LAN use" enforced by the type system,
  not a setting).
- **Group beta rules**: `GROUP_PREVIEW_DAYS = 7`,
  `GROUP_PREVIEW_PARTICIPANT_CAP = 2`, `GROUP_PRO_PARTICIPANT_CAP = 5`
  (GR row line 177: "free preview allows up to two participants; Pro allows
  up to five and continued use beyond the preview"; the card fixes the
  unspecified preview at 7 days). `groupPreview()` returns
  `pro{cap:5} | preview{cap:2,endsAt,daysLeft} | ended{cap:0}`;
  `canStartGroup(n)` enforces both bounds; preview ≠ Pro
  (`isPro("groupChat")` false while preview active — tested).
- **Offline grace**: verified Pro (`proVerifiedAt`) stays usable for
  `OFFLINE_VERIFY_GRACE_DAYS = 30` (not specified by source; chosen and
  documented — pending product confirmation); expiry flips Pro off until
  `verifyPro()` re-runs against the `ReceiptPort` (real receipts = T112).
- **Lock grandfather rule (step 3)**: `grandfatherLockIfPresent(lockPresent)`
  one-time idempotent mark for devices that already had a lock before
  App Lock became Pro; `lockAllowed()` = dev | Pro | grandfathered. New
  devices without Pro cannot enable a lock.
- `require(feature)` / `requireProForEndpoint` → `EntitlementRequiredError`
  for service-side enforcement.
- Tests `test/index.test.mts` **7/7** via root tsx with a fixture clock —
  smoke check 1 satisfied: preview 2-participant + day-8 lockout, purchase
  restores cap 5 (5 ok / 6 refused), grace 29d usable / 32d off / re-verify
  back on, grandfather once-and-persist, dev all-enabled, direct require()
  refusal, restart persistence through the store.
- `tsc -p packages/entitlements` clean.

**Endpoint enforcement demo (`services/api/features/backup`)** — smoke
check 2: `registerBackupRoutes(app, store, gate?)` with
`gate: { isPro() }`; PUT/GET/DELETE answer **402 pro-required** and store
nothing when the real entitlements package says non-Pro (release mode,
receipt pro:false) — proven via direct `app.inject`, bypassing any UI;
after `verifyPro()` the same endpoints answer 200. Junction
`services/api/node_modules/@locallab/entitlements` →
`packages/entitlements`.

### Gates at tip
- `tsc -p packages/entitlements` clean; tsx **7/7**.
- backup routes tsx **6/6** (4 previous + 2 entitlement bypass tests);
  sandbox route unchanged **1/1**; `tsc` (api build-script flags) on
  `features/backup/index.ts` clean.

### Pending (not blocking the card's checks)
- Mobile/release wiring: build mode from build config, `ReceiptPort`
  against App Store receipts (**T112 purchases**), and App Lock
  `EntitlementPort` wiring into `AppLockProvider` (T108 left it
  default-open on purpose; wiring it now without receipts would lock out
  every release user — grandfather hook exists for the migration moment).
- Product confirmation of 30-day offline grace + 7-day preview values.
- Arena feature ids stay inert while Arena remains HELD (T060).


---

## T111 — Optional accounts and password recovery (AC-01, AC-02) — COMPLETE 2026-10-14

Card: `plans/tasks/P10/T111.md` (batch 7). Owned paths:
`services/api/features/auth`, `apps/mobile/features/account`.

### Deviation (documented, dep-frozen workspace)
The card names Better Auth; **no `better-auth` (or jose/openid-client)
exists in node_modules and new npm deps are frozen for this batch**, so the
required behaviors are implemented directly on Fastify + `node:crypto` with
the same security posture. All card steps and smoke checks are met;
swapping to a package later only replaces `registerAuthRoutes` internals.

### What shipped
**Server (`services/api/features/auth`)** — `registerAuthRoutes(app, store, {mail, providers, hasher?, now?})`:
- **Step 1 — anonymous opt-in + verified linking (AC-01)**: `POST
  /auth/anonymous` mints an anonymous user + session (only called when the
  user opts in); `/auth/sign-up` (email+password, scrypt `salt:hash`),
  `/auth/verify-email` single-use codes via the `MailPort`;
  `/auth/oauth` (google/apple) through the injected `ProviderVerifier`
  port; `/auth/link` attaches email/google/apple to the signed-in account;
  a provider account already owned by another user → **409
  identity-conflict** (conflicting-identity smoke case).
- **Step 2 — password reset + secure sessions (AC-02)**:
  `/auth/forgot-password` always answers 200 (no existence leak) and
  mails a single-use reset code; `/auth/reset-password` sets a new scrypt
  credential **and kills every live session** of the account. Session
  tokens: 32 random bytes, stored **SHA-256-hashed only**; verification
  and reset tokens likewise. `scryptHasher({n})` keeps N configurable
  (production 16384, tests 2).
- **Step 3 — local-only needs nothing**: zero routes are required for
  local chat; `memoryAuthStore`/`AuthStore` interface shows the minimal
  server state (users/identities/sessions/pending-email), no chat data.
- `POST /auth/logout` deletes **only the session row** — proven by test:
  after logout the same credentials sign in again (account intact); the
  endpoint cannot touch local chats which live on devices.
- `auth-route.test.ts` **6/6** via root tsx: anonymous+email link;
  signup/verify (single-use, wrong vs missing creds indistinguishable);
  logout-keeps-account; email link conflict 409; google/apple sign-in,
  link, 409 conflict, bad idToken 401; recovery resets password, old
  sessions dead, old password dead, token reuse refused. tsc (api build
  flags) clean.

**Mobile (`apps/mobile/features/account`)**:
- `client.ts`: `createAccountClient({baseUrl, tokens, fetchImpl?})` —
  session in a `SecureTokenPort`; errors surface `{status, code}`; a
  stale stored token is cleared on first 401. No sqlite import anywhere —
  signing out **only** calls `/auth/logout` and clears the token.
- `adapters.ts`: `secureStoreTokenPort()` — Keychain/Keystore key
  `authSessionV1`; never sqlite/sync/backup (matches the DA-03
  credential-path refusal pattern: path regex already refuses
  `authSessionV1`-style credential keys under keychain-ish paths).
- `provider.tsx` + `section.tsx`: settings UI with sign-in / anonymous /
  sign-out; **without a configured service the section renders the
  honest "Local-only mode: no account is required" notice** (step 3 as
  user-visible behavior).
- Mounted: `AccountProvider` inside `BackupProvider` in `app/_layout.tsx`
  (no baseUrl → local-only default); `<AccountSection />` after
  `<BackupSection />` in `features/chat-settings/screen.tsx`.
- `account.test.mts` (vitest) **6/6**: token lands in secure storage on
  sign-in; sign-out clears it and **the request log contains only
  `/auth/logout`** (smoke: logout removes online session, cannot delete
  local chats); stale token auto-cleared; failed sign-in stores nothing;
  409 identity-conflict surfaces; secure-store adapter single key.

### Gates at tip
- services/api auth: tsx **6/6**; tsc clean on `features/auth/index.ts`.
- auth route suite re-ran alongside backup 6/6 + sandbox 1/1 (no regressions).
- `tsc -p apps/mobile` CLEAN; mobile vitest full: **69 passed files + the
  one allowed abort-compatibility collection error; 493 tests passed**
  (baseline 487 + 6).

### Pending (not blocking the card's checks)
- Production `AuthStore` implementation (real DB) and hosted deployment of
  these routes; `memoryAuthStore` is the dev double.
- Real `MailPort` transport (SES/Postmark) and real Google/Apple
  `ProviderVerifier`s (JWKS verification needs client ids/keys — external
  config; interface + doubles already in place, OAuth redirect/native
  id-token plumbing on device is expo-auth-session territory = dep-gated).
- Reset flow currently doesn't re-authenticate the resetter's other
  devices beyond session kill; email change flow not specified by rows.
- Device smoke (Keychain persistence across app restart) once a hosted
  service exists.


---

## T109 — Authenticated PIN recovery service (DA-08) — COMPLETE 2026-10-14

Card: `plans/tasks/P10/T109.md` (batch 7). Owned paths:
`services/api/features/lock-recovery`, `packages/security/recovery`.

### What shipped
**Core `@locallab/security-recovery` (`packages/security/recovery`)** —
recovery grant format + device identity, pure TS (HMAC-SHA256 via the
already-present `@noble/hashes`, resolves by root upward lookup; no new
deps, Hermes-portable incl. hand-rolled canonical base64url):
- **Step 2 — device identity without upload leakage**:
  `createDeviceRecoveryIdentity()` = 32 random bytes; only
  `deviceIdHash = sha256Hex(secret)` is enrolled. PINs/chats never appear
  anywhere in the flow.
- **Signed, expiring grants**: `issueGrant/verifyGrant` — canonical
  fixed-order payload JSON `{v:1,enrollmentId,deviceIdHash,iat,exp,nonce}`,
  base64url body + HMAC-SHA256 signature over the body bytes;
  `verifyGrant` rejects malformed (incl. non-canonical payload),
  bad-signature, expired (constant-time signature compare).
  `DEFAULT_GRANT_TTL_MS = 30 min` (source unspecified; documented).
- `memoryRecoveryStore`: enrollments (email-keyed) + single-use nonce
  ledger (`consumeNonce` false on replay).
- Tests `test/index.test.mts` **6/6** via root tsx (round-trip, expired,
  tamper/wrong-key/wrong-format, hash chain binds identity, nonce once,
  email lookup). tsc (`-p packages/security/recovery`) clean.

**Service (`services/api/features/lock-recovery`)** — `registerLockRecoveryRoutes(app, {auth, recovery, mail, signingKeyHex, grantTtlMs?, now?})`, sessions validated through T111's `AuthStore` (same hashed-Bearer scheme):
- `POST /lock-recovery/enroll` (authenticated): stores
  `{userId, email, deviceIdHash}` — **step 1's grant service enrollment**;
  malformed hash rejected.
- `POST /lock-recovery/request {email}`: unlinked → **200
  `{code:"no-recovery", guidance}` with explicit reinstall/backup
  guidance** (smoke 1); linked → signs a fresh grant (bound to the
  enrollment's device hash, nonce, 30-min expiry) and mails it.
- `POST /lock-recovery/redeem {grant, deviceSecret}` — signature/expiry
  gate (400/410), then device binding `sha256Hex(deviceSecret) ===
  grant.deviceIdHash` (wrong device → **403 cross-device**), then
  single-use nonce (`409 grant-used`). Success answer names the effect:
  `cleared: "lock-verifier-only"` — **step 3**, and app-lock core's
  existing `recoverWithToken` (RecoveryPort seam, T108) clears only the
  verifier.
- `lock-recovery-route.test.ts` **6/6** via root tsx: enroll+mail+redeem
  happy path; enroll needs session (401); unlinked guidance text
  (mentions reinstall + backup); **expired (clock moved), replayed
  (second redeem), and cross-device grants all cannot unlock** (smoke 2);
  forged grant fails closed; even a client that enrolls its raw secret
  where the hash belongs cannot shortcut recovery — redeem hashes again
  → 403. Junction
  `services/api/node_modules/@locallab/security-recovery` →
  `packages/security/recovery`.

### Gates at tip
- recovery core: tsc clean; tsx 6/6.
- lock-recovery routes: tsx 6/6; tsc (api build flags) clean.
- whole api features dir: tsx **20/20** (auth 6, backup 6,
  lock-recovery 6, sandbox 1, search 1) — no regressions.

### Pending (not blocking the card's checks)
- Device-side enrollment + "Forgot PIN?" redemption UI: app-lock already
  consumes a `RecoveryPort` (T108 seam) and `AppLockProvider` accepts one;
  the mobile adapter (store device identity in SecureStore, redeem via
  service with the account session) needs the deployed service + account
  session plumbing (T111 pending hosted deployment).
- Production `RecoveryStore` (real DB) + real `MailPort`; signing key
  management (rotation/KMS) for the grant HMAC key.
- Grant delivery is currently copy-paste code in email body; deep-link
  delivery later.


---

## T112 — Store purchases, restoration and family entitlement (AC-03, AC-04) — COMPLETE 2026-10-14

Card: `plans/tasks/P10/T112.md` (batch 7). Owned paths:
`modules/billing`, `services/api/features/billing`,
`apps/mobile/features/billing`.

### Deviation (documented, dep-frozen workspace)
RevenueCat's native SDKs can't be added (deps frozen); the card itself
scopes live Apple sandbox/Family Sharing to T159E and Google to T125, and
declares signing/store credentials **explicit external release
requirements**. So the purchase verification arrives through the
`StoreVerifier` port (fixture-backed per smoke 1; a RevenueCat adapter
plugs in later without touching the engine).

### What shipped
**Core `@locallab/billing` (`modules/billing`)**:
- **Step 1 — products + webhook reconciliation**: configured
  `ProductConfig[]` catalog (monthly/yearly/lifetime; `priceLabel`/
  `storeSku` supplied by release config — **step 3: nothing observed from
  LM Mini is hardcoded; test asserts the served catalog equals the
  injected config**). `applyWebhook` handles
  initial-purchase/renewal/expiration/refund/restore; reconcile merges by
  transactionId (newest verifiedAt wins) and drops expired records.
- **Step 2 — restore + family**: `restore(userId)` re-verifies the
  store's transactions for the account → cross-device account activation
  without repurchase (test: purchase → new install restore → Pro). Apple
  `isFamilyShared` records grant `source:"family"` entitlements to
  `FamilyPort` members only; Google family-shared receipts refused
  (T125).
- `receiptPortFor(engine, userId)` implements the T107
  `ReceiptPort` — `createEntitlements({mode:"release", receipts: …})`
  `isPro()` after `verifyPro()` is store truth (test wires both packages).
- Dev-free mode: engine never gates by itself; entitlements core's dev
  mode remains the free path (step 3 preserved; see mobile wiring).
- Junction `modules/billing/node_modules/@locallab/entitlements` (test
  wiring) — **one mishap fixed**: an initially mis-created junction
  nested inside `packages/entitlements` was deleted; tree verified clean.
- `test/index.test.mts` **7/7** via root tsx; tsc (`-p modules/billing`)
  clean.

**Service (`services/api/features/billing`)** — `registerBillingRoutes(app, {engine, auth, webhookSecret})`:
- `GET /billing/products` (public, config-sourced), `POST
  /billing/purchase` + `POST /billing/restore` + `GET
  /billing/entitlement` (all Bearer-auth via T111 sessions; entitlement
  resolves through `entitlementForAnyone` so family members see it),
  `POST /billing/webhooks` with **HMAC-SHA256 signature over the raw
  body** (`x-billing-signature`, timingSafeEqual; raw bytes captured via
  a JSON content-type parser) — unsigned/forged webhooks → 401; refund
  webhook revokes a purchased entitlement end-to-end (test).
- Unknown products / store rejections → 400. Secrets/SKUs injected, never
  baked (smoke 2 honored).
- `billing-route.test.ts` **6/6**; tsc (api flags) clean. Junction
  `services/api/node_modules/@locallab/billing`.

**Mobile (`apps/mobile/features/billing`)**:
- `client.ts`: products/entitlement/purchase/restore via the account's
  `SecureTokenPort` bearer sessions; `BillingApiError{status, code}`;
  `NativePurchasePort {purchase(sku)→receipt|null}` seam (null = user
  cancel).
- `provider.tsx` `BillingProvider`: catalog + entitlement state, purchase
  (refuses with honest error when the native adapter is absent),
  **restore button path**, and an `entitlementPort` exposed for Pro
  gating — `null` when no billing service is configured so consumers stay
  dev-free/default-open.
- **Step 3 on device — dev-free preserved**: `app/_layout.tsx` remounted
  as AccountProvider → BillingProvider → `ProAwareLockProvider` (bridge
  inside _layout) → BackupProvider → Diagnostics. When a billing service
  is configured, App Lock's `EntitlementPort` (T107/T108 seam) is fed by
  live entitlements — new lock enables consult Pro, existing lock records
  grandfather per app-lock core ("only NEW enables consult
  entitlements"). With no service (every build today), the port stays
  `undefined` and App Lock stays default-open.
- `section.tsx`: Pro status (incl. family/lifetime/subscription labels),
  product rows **rendering server-config price labels only**, Buy
  (native adapter gated with an honest notice), "Restore purchases";
  testIDs `billing-section/-pro/-restore/-purchase-<id>/-unavailable`.
  Mounted after `<AccountSection />` in chat-settings screen.
- `billing.test.mts` (vitest) **5/5**: catalog comes over the wire
  (no local price constants), bearer attached, receipt submitted after
  native purchase, restore reactivates, refusal codes surfaced.

### Gates at tip
- billing core: tsc clean; tsx **7/7**.
- api features dir: tsx **26/26** (auth 6, backup 6, lock-recovery 6,
  billing 6, sandbox 1, search 1).
- `tsc -p apps/mobile` CLEAN; mobile vitest: **70 passed files + the one
  allowed abort-compatibility failure; 498 tests passed** (493 + 5).

### Pending (not blocking the card's checks)
- RevenueCat/StoreKit/Play Billing `NativePurchasePort` + server
  `StoreVerifier` adapters: live Apple sandbox/Family Sharing = T159E,
  Google = T125; **App Store/Play signing, store credentials, and
  RevenueCat secrets are explicit external release requirements**.
- Hosted deployment of billing routes + real webhook secret management;
  production `PurchaseStore` (real DB).
- Deep device matrix (purchase/restore UI on hardware) after store
  adapters exist.


---

## T106 — Community theme and voice catalog service (UI-02, AC-08) — COMPLETE 2026-10-15

Card: `plans/tasks/P10/T106.md` (batch 7). Owned paths:
`services/api/features/catalog`, `apps/mobile/features/community`.

### What shipped
**Service (`services/api/features/catalog`)** — `registerCatalogRoutes(app, {store, auth, isAdmin?, now?})`:
- **Step 1 — authenticated publish, public read, revisions, safe asset
  validation**: `GET /catalog/themes` + `GET /catalog/themes/:id`
  (id-or-slug) + `GET /catalog/themes/:id/revisions` are public reads.
  `POST /catalog/themes` (Bearer via T111 sessions) requires a slug
  (`^[a-z0-9][a-z0-9-]{2,63}$`) and a doc validated by the shared
  **`parseThemeImport`** from `@locallab/themes-schema` — its `.strict()`
  zod schema is the safe-asset validator: unknown/scripted/chat-bearing
  fields are refused (test: a theme with an embedded `messages:[…]`
  payload → 400 `invalid-theme`; smoke 2 "no chat text" holds by
  structure: listings are metadata-only, docs are schema-shaped, tests
  assert no message/conversation/prompt keys in responses).
  `POST /catalog/themes/:id/revisions` is **author-only** (403
  `not-author` for other signed-in users), bumps revision n+1, full
  history retained. Slug conflicts → 409.
- **Step 2 — administratively curated voice metadata independent from
  secret keys**: `GET /catalog/voices` public; `POST /catalog/voices` +
  `DELETE /catalog/voices/:id` require a session AND `isAdmin(userId)`
  (403 `not-admin`). `safeVoiceMetadata` refuses any body whose keys match
  `/(key|secret|token|password|credential|apikey)/i` (test: `apiKey` in
  the pack → 400 `invalid-metadata`), bounds all fields, and stores only
  {slug,name,vendor,modelLabel,languages[]} — no endpoints, no store or
  provider secrets anywhere in the catalog.
- Local seeded dev service: `memoryCatalogStore()` — **step 3: dev
  fixture only; live hosted catalog proof stays T159E** (card scope).
- `catalog-route.test.ts` **6/6** (node:test + fastify inject; sessions
  via `auth.insertSession(sha256(token))`); tsc (api flags) clean.
  Junction `services/api/node_modules/@locallab/themes-schema` (zod 4.1.12
  resolves through the schema package's own node_modules — no new deps).

**Mobile (`apps/mobile/features/community`)**:
- `client.ts`: `createCommunityClient({baseUrl, tokens: SecureTokenPort
  (shared with T111 account), fetchImpl?})` — listThemes/getTheme/
  publishTheme/listVoices; `CatalogApiError{status, code}`.
- `provider.tsx` `CommunityProvider`: catalog state + refresh/download/
  publishTheme; unavailable (no baseUrl) → honest "themes stay on this
  device" state.
- `section.tsx` `CommunitySection`: browse listings, **Import** per theme
  → download → **`parseThemeImport` re-validation on device** (defense in
  depth; a malformed remote theme never reaches the theme store, same
  smoke 1 round-trip enforced client-side) →
  `useAppTheme().saveCustomTheme(…)` + `setThemeId` (exact T104 editor
  path); **Publish current theme** = the selected custom theme, slugified
  id; curated voice list rendered (names/languages only). testIDs
  `community-section/-unavailable/-import-<slug>/-publish/-voices`.
  Mounted after `<BillingSection />` in chat-settings;
  `CommunityProvider` in `_layout` chain:
  Account → Billing → Community → ProAwareLock → Backup → Diagnostics.
- `community.test.mts` (vitest) **4/4**: public list carries no
  authorization header, slug download, publish attaches bearer + strict
  doc body, 400 `invalid-theme` surfaces as `CatalogApiError`.

### Smoke checks
- Publish → public download → device import (parse+save+setThemeId)
  round-trip path exercised across service tests + client tests;
  malformed remote themes rejected at publish (strict schema) and again
  on-device before store writes.
- Catalog requests/responses carry no chat text (metadata + strict theme
  docs only; asserted in tests).

### Gates at tip
- api features dir: tsx **32/32** (auth 6, backup 6, lock-recovery 6,
  billing 6, catalog 6, sandbox 1, search 1).
- `tsc -p apps/mobile` CLEAN; mobile vitest: **71 passed files + the one
  allowed abort-compatibility failure; 502 tests passed** (498 + 4).

### Pending (not blocking the card's checks)
- Live hosted catalog deployment + seeded production catalog = **T159E**
  (card defers hosted proof).
- Production `CatalogStore` (real DB) + admin role management beyond the
  injected `isAdmin` port; voice pack binaries/asset hosting (card scope
  is metadata curation only).
- UI walkthrough on device (import/publish from the community section).


---

## T113 — Support board, attachments and release updates (AC-05, AC-06, AC-07) — COMPLETE 2026-10-15

Card: `plans/tasks/P10/T113.md` (batch 7). Owned paths:
`services/api/features/support`, `apps/mobile/features/support`.
Also touched (dependency seam): `services/api/features/auth`
(`AuthStore.deleteUser` added to the interface + memory store; auth
suite still 6/6).

### What shipped
**Service (`services/api/features/support`)** — `registerSupportRoutes(app, {store, auth, now?})`:
- **Step 1 — requests/votes/comments/unread + attachments on explicit
  submit**: `POST /support/requests` (Bearer; kind
  feature-request|support-ticket, title ≤120, body ≤4000; author gets
  the initial vote) and `GET /support/requests` (public board with vote
  counts; with a session adds `myVote` + `unreadReplies` = comments
  newer than the user's last-read marker → `POST
  /support/requests/:id/read` clears, and new replies re-arm it — test
  covers clear-then-rearm). Comment threads with `parentId` replies
  (parent must belong to the request, else 400 `bad-parent`).
  Attachments: `POST /support/requests/:id/attachments` accepts
  base64 with an allowlisted contentType (png/jpeg/pdf/text), ≤5MB,
  else 400 `invalid-attachment` (exe upload refused in test); `GET
  /support/attachments/:id` (session) returns exact bytes round-tripped.
- **Step 3 — changelog/update checks + account deletion**: `GET
  /support/changelog` (dev-seeded via `memorySupportStore({changelog})`),
  `GET /support/version?app=X` → semver compare →
  `{latest, upToDate}` (1.2.0 → stale, 1.3.0 → up-to-date in test).
  `DELETE /support/account` (Bearer) wipes the user's requests,
  comments, attachments, votes and read markers (`deleteAllFor`), then
  `auth.deleteUser` (new store method: user, identities, sessions,
  pending emails) — test asserts board/comments empty and the session
  token is dead afterward.
- `support-route.test.ts` **6/6**; tsc (api flags) clean.

**Mobile (`apps/mobile/features/support`)**:
- `client.ts`: board/request/create/vote/comment/read/attachment/
  changelog/versionCheck/deleteAccount over the account's
  `SecureTokenPort`; `SupportApiError{status, code}`.
- **Step 2 — chat support entry with optional redacted diagnostics**:
  `redacted-diagnostics.ts` builds a fixed-field summary (app version,
  platform, model/conversation COUNTS, sanitized last error CODE, free
  memory) — field sanitizers refuse free text: a smuggled
  `lastErrorCode: "ERROR during chat: my private prompt"` or
  free-text platform come out as `none`/`unknown` (vitest asserts the
  secret words never appear in the output). The summary is appended to a
  submission ONLY when the user explicitly toggles it; with no
  `diagnosticsSource` configured the toggle honestly refuses instead of
  sending fake data.
- `provider.tsx` `SupportProvider` (+ `AttachmentSourcePort` native pick
  seam, + `diagnosticsSource` port); `section.tsx`: board rows with vote
  toggles, unread dot (●), update-available banner, new-request form
  (explicit Submit), diagnostics toggle, changelog rows, delete-account
  confirm flow. testIDs `support-section/-unavailable/-update-available/
  -request-<id>/-vote-<id>/-open-<id>/-title/-body/
  -diagnostics-toggle/-submit/-changelog-<version>/-delete-account/
  -delete-confirm/-delete-yes/-delete-no`. Mounted after
  `<CommunitySection />` in chat-settings; `SupportProvider` in
  `_layout`: … Billing → Community → Support → ProAwareLock → …
- `support.test.mts` (vitest) **5/5**: typed create (no extra fields),
  vote/comment/read/attachment endpoint paths + bodies, version query +
  DELETE, and both redacted-diagnostics properties.

### Smoke checks
- Voting/comment/unread round-trip: service tests (vote up/down, reply
  threads, clear-then-rearm unread) + client path tests. Attachment
  upload/download byte-exact round-trip.
- No conversation content on the wire: request bodies carry only
  kind/title/body the user typed (test asserts exact payload); the
  diagnostics builder structurally cannot carry free text and is opt-in;
  no client call exists that could read chat storage.

### Gates at tip
- api features dir: tsx **38/38** (auth 6, backup 6, lock-recovery 6,
  billing 6, catalog 6, support 6, sandbox 1, search 1).
- `tsc -p apps/mobile` CLEAN; mobile vitest: **72 passed files + the one
  allowed abort-compatibility failure; 507 tests passed** (502 + 5).

### Pending (not blocking the card's checks)
- Native `AttachmentSourcePort` (image picker) + real
  `diagnosticsSource` wiring on device builds (counts/version/error
  codes from the live app) — honest refusal paths shipped meanwhile.
- Production `SupportStore` (real DB) + moderation/admin tooling;
  attachment storage beyond memory store.
- Store release feed for the changelog/update check (App Store/Play
  metadata) — release-notes seeding is config-driven today.
- Device walkthrough of the support board UI.

---

## T118 — Diagnostics, analytics and benchmark consent (DA-04, UI-19, AR-09) — COMPLETE 2026-10-15

Card: `plans/tasks/P10/T118.md` (batch 7). Owned paths:
`packages/diagnostics`, `services/api/features/metrics`,
`apps/mobile/features/diagnostics`.

### What shipped
**Core (`packages/diagnostics` → new pure package `@locallab/diagnostics`,
zero runtime deps)**:
- **Step 3 — allowlisted event properties excluding
  prompts/audio/keys**: `EVENT_ALLOWLIST` is a fixed event→props map
  (`app-launch`, `session-length`, `worker-status`, `error-occurred`,
  `provider-status`, `benchmark-result`); `validateEvent` rejects any
  non-allowlisted key AND non-slug string values (`^[A-Za-z0-9_.:-]{1,64}$`
  — a sentence with spaces fails) and secret-shaped values
  (`sk-…`, key/secret/token/password words), so prompts/chat text/keys
  are inexpressible in the event model, not just filtered.
- **Step 2 — anonymous metrics off until explicit consent**:
  `createAnalyticsBuffer({isConsented, transport})`: with consent off the
  event is dropped BEFORE buffering — the queue is literally empty, so a
  network audit with consent off observes zero analytics sends by
  construction. `consentKindFor` splits `benchmark-result` (AR-09) from
  product analytics (DA-04): benchmark sharing is a separate opt-in.
  Consent revocation on device rebuilds the buffer (queued events drop).
- **Step 1 — local counters + redacted support bundle**:
  `createMetricsCollector` (slug-named counters, capped, bounded);
  `buildSupportBundle({snapshot, errors})` → counters + error summaries
  passed through `redactBundleLine` (strips `sk-…`, 32+ hex, 64+ base64,
  UUIDs; 120-char clip) — no message content fields exist in the bundle.
- `aggregateEvents` → `{eventCounts, workerMaxQueueDepth,
  errorCodeCounts, lastSeenAt}` derived purely from stored events.
- Gate: tsx `--test test/index.test.mts` **6/6**; `tsc -p
  packages/diagnostics` clean.

**Service (`services/api/features/metrics`)**:
- `POST /metrics/events`: every event in the batch runs through the
  shared `validateEvent`; ANY invalid event → 400 `invalid-event` and
  nothing stored (all-or-nothing) — test posts a batch with a
  `lastMessage: "secret conversation content"` prop and asserts the
  store stays empty. ≤200/batch.
- `GET /metrics/dashboard` (UI-19): `aggregateEvents(store.allEvents())`
  — empty store ⇒ empty aggregate (explicit "no fixtures" test); posted
  worker-status/error-occurred events show real per-worker max queue
  depth and per-code error counts.
- `memoryMetricsStore()`; `metrics-route.test.ts` **4/4**; single-file
  tsc clean; junction `services/api/node_modules/@locallab/diagnostics`.

**Mobile (`apps/mobile/features/diagnostics` — additions, existing
trace-log provider contract untouched)**:
- `analytics.ts`: `createAnalyticsClient` (POST /metrics/events, GET
  /metrics/dashboard), `createAnalyticsCoordinator` — consent state
  behind a `ConsentPort` (off by default; `memoryConsentPort`), separate
  product/benchmark flags wired into the core buffer's `isConsented`,
  `recordTrace(traceSnapshot)` bumps real per-phase and
  `trace.failed.<code>` counters and queues code-only `error-occurred`
  events (entry `detail` never travels — only the code slug),
  `flushAnalytics`, `localSnapshot`.
- `analytics-section.tsx`: mounted in chat-settings after
  `<SupportSection />`; both consent toggles render OFF until tapped;
  local counters subscribe to the real `traceLog` (dashboard shows this
  device's actual failures, not fixtures); optional server dashboard
  refresh renders the service aggregate. testIDs
  `analytics-section/-consent-product/-consent-benchmark/-send/
  -refresh/-counter-<name>/-event-<name>/-error-<code>/
  -server-dashboard`.
- `analytics.test.mts` (vitest) **6/6**: consent-off audit — record +
  recordTrace + flush leaves the client double with zero sends and zero
  dashboard calls; trace counters reflect real failed entries (2×
  `model-load-failed`); product-consent-on flush sends one allowlisted
  batch; benchmark event refused under product consent alone, accepted
  under benchmark consent; revoking consent drops the queue; client
  endpoint paths.
- Junction `apps/mobile/node_modules/@locallab/diagnostics`.

### Smoke checks (card)
- **Network audit with consent off sends zero analytics**: mobile test
  asserts the transport/fetch double is never called after record +
  recordTrace + flush with both consents off; core test asserts record
  returns `stored:false` and `pending()===0` — nothing to leak.
- **Dashboard reflects actual workers/errors, not fixtures**: api test —
  dashboard after real posts shows `workerMaxQueueDepth["media-queue"]=9`
  and `errorCodeCounts["model-load-failed"]=1`; empty-store dashboard is
  all-empty (asserted deepEqual). Mobile section counters come from
  `traceLog.getSnapshot()` entries; core `aggregateEvents([])` = empty.

### Gates at tip
- `@locallab/diagnostics` tsx 6/6 + tsc clean.
- api features dir: tsx **42/42** (was 38; +4 metrics).
- `tsc -p apps/mobile` CLEAN; mobile vitest: **73 passed files + the one
  allowed abort-compatibility failure; 513 tests passed** (507 + 6).

### Pending (not blocking the card's checks)
- Persistent on-device `ConsentPort` (SecureStore-backed) + onboarding
  prompt copy; today the coordinator defaults to memory port —
  revocation/queuing behavior is proven, storage of the flags across
  restarts is the remaining wiring.
- A production `MetricsStore` (real DB) behind the api routes; events
  today land in `memoryMetricsStore`.
- Device-side scheduled flush (app-lifecycle timer) — user-triggered
  "Send now" shipped; benchmark-result producers will feed the same
  gate when benchmark runs land.

---

## T114 — iOS widgets and Live Activities (AU-01, AU-02) — COMPLETE (native build proof pending T159E) 2026-10-15

Card: batch-8 queue item 1 ("Automation/accessibility"). Owned paths:
`modules/widgets/ios`, `apps/mobile/features/widgets-ios`.

### What shipped
**Bridge contract module (new `modules/widgets/ios` → `@locallab/widgets-ios`,
zod-only dep)**:
- **Step 1 — quick-entry entry points**: `WidgetEntryKindSchema`
  (new-chat / camera / news) + `widgetRouteUrl` /
  `parseWidgetRouteUrl` on the registered `locallab` scheme
  (`locallab://widget/<kind>`; foreign schemes and unknown kinds
  refuse). Control Center/WidgetKit extensions consume exactly these
  routes; the Swift extension build is T159E (same convention as
  T100's icloud bridge: frozen TS contract now, compiled/installed on
  the Apple build later).
- **Step 2 — App Group snapshot with no secret/chat payload**:
  `DownloadActivityStateSchema` (modelClass slug + percent 0–100 +
  finished flag) and `GenerationActivityStateSchema` (**has no preview
  field at all** — a generation activity shows only "generating with
  <modelClass>") are `.strict()`; `WidgetSnapshotSchema`
  (generatedAt, pinnedModelClasses slugs, nullable download/generation
  activity, updateAvailable badge) is `.strict()` too. Tests assert a
  `chatText`/`prompt`/`apiKey` key and free-text values
  ("my private chat text", "the model answer text", percent 101) all
  refuse — chat/secret payload is inexpressible in the shared
  container.
- **Step 3 — reconcile after foreground/relaunch**: pure
  `reconcileActivities(activities, {now, maxAgeMs})` → finished
  activities end, never-finished ones older than the max age end (dead
  process), fresh running ones keep.
- `WidgetsBridge` interface (writeSnapshot / start/update/endActivity /
  listActivities) is the Swift-side seam.
- Gate: tsx `--test test/index.test.mts` **4/4**; `tsc -p
  modules/widgets/ios` CLEAN.

**Mobile (`apps/mobile/features/widgets-ios/snapshot-publisher.ts`)**:
- `createWidgetSnapshotPublisher({bridge?, now?})`: every write goes
  through the strict schemas before the bridge sees it (invalid → false,
  bridge untouched); no bridge on non-Apple builds → honest no-ops.
  `reconcile()` additionally ends rows the current contract cannot read
  (older app versions) so the Lock Screen never shows frozen rows.
- Junction `apps/mobile/node_modules/@locallab/widgets-ios`.
- `widgets.test.mts` (vitest) **4/4**: no-bridge no-ops; chat-text
  snapshot refuses while the valid one writes; `preview` smuggle in a
  generation activity refuses; relaunch reconcile ends exactly
  finished + stale + unreadable rows and keeps the live one.

### Smoke checks (card)
- "Widget/Live Activity/quick-entry builds install and open the expected
  app route": route contract proven by parser/round-trip tests; the
  install-and-open proof is native — **pending T159E** (Apple build),
  recorded below, not claimed.
- "Lock-screen/progress and permission/OS matrix are T159E": acknowledged
  by the card; nothing extra claimed.

### Gates at tip
- `@locallab/widgets-ios`: 4/4 + tsc clean.
- `tsc -p apps/mobile` CLEAN (publisher in the project graph); vitest
  widgets **4/4** (full mobile suite re-run follows at batch close).

### Pending (not blocking the card's checks)
- Swift WidgetKit extension + ActivityKit attributes + App Group
  container wiring compiled into the Apple build; lock-screen/permission
  matrix — T159E device gate.
- The "news" widget's configured-news source (what feeds
  pinnedModelClasses/news rows) lands with the automation recipes work
  (T117x) — snapshot field is contract-ready.
- App-side call sites that push progress into the publisher during real
  downloads/generations (generation-lifecycle/download features already
  emit progress events; adapter wiring rides the next Apple-build
  session with the Swift code).

---

## T116 — App Intents and typed deep-link automation (AU-03, AU-04, AU-05) — COMPLETE 2026-10-15

Card: batch-8 queue item 3 ("Automation/accessibility"). Owned paths:
`modules/app-intents/ios`, `packages/automation`, `apps/companion/automation`.
AU-05's deep-link family is implemented on this project's **`locallab://`
scheme** (the original product scheme is never used, per AU-05 note).

### What shipped
**Typed deep-link contract + runner (`packages/automation` →
`@locallab/automation`, zod-only dep)**:
- **Step 1 — `locallab://shortcut/...` family (AU-05)**: six actions
  ask/search/voice/summarize/translate/news (AU-04), each with a
  per-action `.strict()` zod intent: ask{q 1–2000, modelClass?},
  search{q 1–200}, voice{no params}, summarize{modelClass?},
  translate{lang `^[a-z][a-z-]{1,7}$`, modelClass?}, news{read
  bool default false}. Query grammar hand-parsed (≤8 pairs, dup keys
  refused); **unknown params refused** (`?token=sk-…` fails),
  **`%`-encoding refused outright** (no decode attack surface),
  foreign schemes refused.
- `serializeIntent` — canonical JSON (fixed key order action→q/lang→
  modelClass→read) = the **cross-language golden fixture**: the TS test
  and the Rust test assert the same byte-identical strings for all six
  actions.
- Runner `createShortcutRunner({services}).runUrl(url, {foreground})` →
  done / refused{malformed,voice-denied,no-import} /
  review-required{share-import,voice-permission}.
- **Step 3 — foreground review**: summarize/translate consume the
  Share Sheet import only with `foreground:true` (background launch →
  review-required, service untouched; no import → refused); voice needs
  permission granted (undetermined → review-required, denied →
  refused, `services.voice` never called).
- Tests (`test/index.test.mts`, node:test) **5/5**: golden parse +
  byte-exact serialization per action; 10 hostile/malformed URLs all
  refuse; untrusted URL executes **zero** service calls (smoke 2);
  each action invokes the same service the UI uses (smoke 1); the
  review rules above.
- Gate: tsx **5/5**; `tsc -p packages/automation` CLEAN.

**iOS App Intents bridge contract (`modules/app-intents/ios` →
`@locallab/app-intents-ios`)**:
- **Step 2 — AU-03 entry points**: `ENTRY_POINTS` = siri /
  action-button / share-sheet / widget / scheduled;
  `APP_INTENT_NAMES` = the six named intents
  (LocalLabAskIntent … LocalLabNewsIntent) with
  `actionForIntent` one-to-one onto the six shortcut actions;
  `ShareSheetPayloadSchema` strict {text 1–20000 control-char-free,
  contentType: text/plain only} — no other MIME, no extra fields;
  `requiresForegroundReview` true for summarize/translate/voice (same
  step-3 rule as the runner). Swift AppIntents extension compiles
  against this contract in the Apple build — same convention as
  T114/T100: contract frozen now, native proof T159E (recorded
  pending).
- Junction `modules/app-intents/ios/node_modules/@locallab/automation`.
- Tests **3/3**; `tsc -p modules/app-intents/ios` CLEAN.

**Desktop CLI equivalent (`apps/companion/automation/mod.rs`, mounted
in `src/lib.rs` as `pub mod automation` via
`#[path = "../automation/mod.rs"]`)**:
- Same strictness ported by hand (no new crates): prefix + action
  charset check, per-action param allowlists, dup keys, ≤8 pairs,
  q length/% rules, modelClass/lang regex-equivalents, read
  true/false only → `ShortcutError {kind:"malformed"}`.
- `serialize_intent` produces the byte-identical canonical JSON
  (same fixture strings as the TS test — cross-language parity
  asserted on both sides).
- `ShortcutServices` trait + `run_shortcut(&mut impl, url,
  foreground)` with the identical done/refused/review-required
  outcome set and voice/share-review gates.
- 7 cargo tests (Rc<RefCell<Vec<String>>> spy): goldens, 11 refusals
  incl. `read=maybe`, service parity, zero-calls on untrusted URL,
  share-import background/foreground/no-import, voice permission
  states, CLI argv→intent round trip.

### Smoke checks (card)
- [x] "Each action invokes the same service as UI with valid fixture":
  TS test 3 + Rust `every_action_invokes_the_same_service_as_the_ui`
  (spy call logs `ask:hello:-`, `search:hi`, `voice`, `news:true` —
  identical on both sides).
- [x] "malformed/untrusted URL cannot execute arbitrary tools or
  access secrets": 10–11 refusal fixtures per side + explicit
  zero-service-calls tests; unknown params are refused (no secret
  parameter can even be parsed); `%`-encoded payloads refused.

### Gates at tip
- `tsc -p packages/automation` CLEAN; tsx **5/5**.
- `tsc -p modules/app-intents/ios` CLEAN; tsx **3/3**.
- `cd apps/companion && cargo test` = **66 passed, 0 failed, zero
  warnings** (59 baseline + 7 automation).
- Batch-8 gate re-run at tip: FULL mobile vitest = **75 files
  (74 pass + the one allowed failing file
  `platform/abort-compatibility.test.mts` collection error), 517
  tests passed** (baseline advances 65/469 → 74/517);
  `tsc -p apps/mobile` CLEAN.

### Pending (recorded, not claimed)
- Swift AppIntents extension (Siri/Action Button/Share Sheet
  registration) compiled into the Apple build + device matrix —
  T159E.
- Scheduled Shortcuts runs honoring the no-background-sensitive rule
  natively (contract side shipped).


## T117A — Summary recipes: article/meeting/Speech Shrink (AU-04) — COMPLETE 2026-10-15

Owned path: `packages/workflows/summaries` (`@locallab/workflows-summaries`, zod-only).
Steps: three `SUMMARY_WORKFLOWS` (article-summary, meeting-minutes, speech-shrink);
explicit per-source caps (share-sheet 20000, transcript 60000) — over-cap user
material is REFUSED, never silently truncated; fixture-stable prompt templates;
Speech Shrink supports 25/50 target percent. Smoke: exact golden prompt (joined
lines), artifact {format markdown, editable:true, sourceLength}, reasons
source-empty/source-too-long/model-unavailable. Gates: tsx **5/5**, tsc clean.

## T117B — Writing recipes: unChatGPTfy/rephrase/writing help/social posts (AU-04) — COMPLETE 2026-10-15

Owned path: `packages/workflows/writing` (`@locallab/workflows-writing`).
Steps: `WRITING_WORKFLOWS` unchatgptfy/rephrase-email/help-me-write/social-media;
`SelectedTextSchema` (text ≤8000 + origin selection|share-sheet|clipboard) preserves
user text verbatim; four distinct tone-controlled prompt templates with optional
persona line; `commitPreviewToClipboard` writes ONLY on user-confirmed tap.
Smoke: template goldens distinct, clipboard spy empty before confirm, tone/persona
echo, caps. Gates: tsx **4/4**, tsc clean.

## T117C — Story and emotional-support recipes (AU-04) — COMPLETE 2026-10-15

Owned path: `packages/workflows/creative` (`@locallab/workflows-creative`).
Steps: story/emotional-support discriminated union running through ordinary local
chat prompts (Persona-capable; provider choice stays in provider UI); support
template forbids diagnosis and points to professional/crisis help; context retained
ONLY on explicit opt-in (`saveContext:true`, default isolated). Smoke: both recipes
run on a local model, isolation vs retention spy (ContextPort call log empty
unless opted in), model loss named. Gates: tsx **4/4**, tsc clean.

## T117D — Screenshot chat and business-card scanner on OCR bridge (AU-06) — COMPLETE 2026-10-15

Owned paths: `modules/ocr/ios` (`@locallab/ocr-ios`) + `packages/workflows/camera`
(`@locallab/workflows-camera`, junction to ocr-ios present).
Steps: on-device OCR contract (opaque imageRef — paths refused; `onDevice:true`
literal required; text ≤40000); `parseCardFields` line heuristics re-checked
through strict `CardFieldsSchema` (junk OCR yields `{}`); `confirmContactWrite`
writes Contacts ONLY on confirmed tap; `routeScreenshotChat` → vision-model route
when a vision class exists, explicit OCR-text prompt otherwise. Smoke: card
fixture fields exact, junk refused, no-Contacts-write test, both routes. Swift
Vision compile proof = T159E (recorded pending). Gates: ocr-ios tsx **4/4**,
camera tsx **3/3**, both tsc clean.

## T117E — Recipe maker, grocery genius, tourist guide (AU-04) — COMPLETE 2026-10-15

Owned path: `packages/workflows/planning` (`@locallab/workflows-planning`).
Steps: three inputs with bounded preferences (ingredients ≤40×60, servings 1–12,
budget ≤$1000, days 1–14, lat/lon ranges); servings/budget/location/days stay
user-reviewable `ReviewablePlanFields`; tourist prompts forbid invented hours
("check locally"); live place recommendations ONLY through an enabled search
port, else explicit `{available:false, notice:"search-not-enabled"}` and no port
call. Smoke: three prompt goldens (`Plan 3 servings`, `$25`, `Interests: temples`),
search-off spy untouched, search-on query golden, caps/unknown-field refusals.
Gates: tsx **4/4**, tsc clean.

## T117F — Voice and search shortcut actions incl. CallKit call (AU-08) — COMPLETE 2026-10-15

Owned path: `packages/workflows/voice-actions` (`@locallab/workflows-voice-actions`).
Steps: four actions (search / ask-on-device / voice-chat / call) bound to declared
ports only (search, session, call, mic); model+persona always explicit
(`ModelSelectionSchema`, empty model refused); mic permission gates voice actions
(denied → mic-denied, undetermined → mic-unavailable, no port touched). Smoke:
four actions activate right screens with exact port-call log; `stop()` /
`stopVoiceSession` release the mic (mic-close asserted). Gates: tsx **4/4**, tsc clean.

## T117G — CtxLLM retained context and Translate Clipboard (AU-07) — COMPLETE 2026-10-15

Owned paths: `packages/workflows/context` + `packages/workflows/translation`.
Steps: context rides chat prompts, persists across runs until user-initiated
`clearContext`; storage is only the injected app-owned port — no network/off-device
sync seam exists; set/update is explicit and validates (empty/oversized refused,
never truncated). Translation validates clipboard read (null/blank/over-10000
refused) and writes back ONLY on successful non-empty translation. Smoke:
context survives two runs then cleared (prompt golden), storage call log, failed
translation leaves clipboard byte-identical (both model-unavailable and
empty-output), bad language codes refused. Gates: context tsx **4/4**,
translation tsx **3/3**, both tsc clean.

## T117H — Weather Reporter and Morning News Brief (AU-08) — COMPLETE 2026-10-15

Owned paths: `packages/workflows/briefings` + `services/api/features/news`.
Steps: topics/time/voice are user inputs (time regex-bounded); live sources only
via ENABLED search provider (offline path states live data is missing, spy proves
no call); notifications scheduled ONLY when user opted in (`notify:true`); briefs
cached with freshness stamp — fresh serves without regeneration, stale refreshes.
API feature composes briefs from the hosted-search facade only: fixture brief,
fresh-cache + refetch after maxAge, disabled provider → 403 explicit, unconfigured
→ 409 (never a faked brief), malformed q → 400. Gates: briefings tsx **4/4**,
tsc clean; api news 2 tests, full api features glob **44/44**.

## T117 — Twenty-two Shortcut recipes integration gate — COMPLETE 2026-10-15

Owned paths: `packages/workflows/integration` + `apps/mobile/composition/workflows`.
Steps: `RECIPE_LEDGER` registers all 22 source-catalog recipes against one typed
automation intent binding (`RecipeIntentBinding` over the six automation
`SHORTCUT_ACTIONS`; intent params filled from user-editable prompt/input,
`promptEditable:true` on every entry); golden request fixtures validated against
each recipe's REAL package schema; declared ports aggregated in
`DeclaredWorkflowPorts` (clipboard, contacts, voice, context, planning search,
briefing search); ledger-vs-catalog diff (`diffLedgerAgainstCatalog`) = exact
match on all 22 names, and kind classification (action vs bare menu item) is
recorded — catalog lists all 22 as packaged workflows, ledger asserts
`kind:"action"` throughout. Mobile mount: `createWorkflowRegistry()` drives the
dev entry route table from the ledger (junction + workspace dep wired).
Smoke: integration tsx **4/4** (catalog golden, hostile `{}`/null never validate,
unique ids/routes, intent membership); mobile `composition/workflows/registry.test.mts`
vitest **3/3**. Batch-8 gate: mobile vitest 76 files = 75 pass + the one allowed
`platform/abort-compatibility.test.mts` collection error, **520 tests passed**;
`tsc -p apps/mobile` clean; `cargo test` **66 passed, 0 failed, zero warnings**;
api features **44/44**. Physical Siri/Share Sheet/scheduled matrix = T159D pending.

## T119 — iPhone localization and accessibility (UI-10, UI-17, UI-18) — COMPLETE 2026-10-15

Owned paths: `packages/localization` + `apps/mobile/features/responsive/iphone`.

### What shipped
**Localization catalog (`packages/localization` → `@locallab/localization`):**
six complete resource catalogs — English, Chinese, Spanish, French, German,
Russian — over a 12-key UI string set (tabs, send/stop/new-chat, search field,
mic permission, model ready/downloading/offline, empty-chat).
`resolveLocalePreference(userPick, systemLocale)`: explicit pick wins, else the
system locale's language prefix selects the catalog (zh-Hans-CN → zh, fr_CA →
fr), unknown systems fall back to English. Audit helpers for step 3:
`missingKeys` (English fallbacks), `overlongLabels` (long-string budget = 2.5x
English), `isRtl` mirroring rule, and WCAG `contrastRatio` math for UI-18.

**iPhone responsive + accessibility (`features/responsive/iphone`):**
`columnCount` = 2 columns in landscape (844x390, 667x375 golden), 1 in portrait
(UI-10); `scaledFontSize` honors dynamic type but clamps at 2x and never drops
below the system default, so large-text routes keep navigating (smoke check 1).
Audits (step 3): `touchTargetViolations` flags native controls under the 44pt
floor; `focusOrderViolations` flags repeated/backwards keyboard traversal.
Accessibility (UI-18): `voiceOverLabels(locale)` returns non-empty labels for
every navigation key in all six locales (VoiceOver routing never blocked);
`statusIndicator` pairs color tokens with text in every locale — status never
rides on color alone (`offline` → "离线" golden); `contrastFailures` enforces
WCAG floors per pair (4.5 normal, 3.0 large/UI).

### Smoke coverage
localization tsx **4/4** + tsc (catalog completeness, follow-system selection
incl. ja-JP/"" fallback, long-string + RTL audit, WCAG golden: black/white = 21,
#767676 passes 4.5 while #777777 fails); mobile
`features/responsive/iphone/iphone-responsive.test.mts` vitest **7/7**
(portrait/landscape columns, clamp + NaN handling, 43pt flagged, focus order,
labels/status in all six locales, contrast audit pass/fail). Full mobile suite:
77 files = 76 pass + the one allowed `platform/abort-compatibility.test.mts`
collection error, **527 tests passed**; `tsc -p apps/mobile` clean (junction +
workspace dep for `@locallab/localization` wired).

### Pending
Full physical accessibility/language device matrix = T159H (recorded pending).
iPad layout, Settings two-pane and Pencil = T119B (separate card; not started).
