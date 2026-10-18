# LocalLab continuation handoff — Qwen3.8-Flash-Next q3, 128K

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../../plans/POWERSHELL.md).

Approved direction recorded October 8, 2026. Start with [START_HERE.md](START_HERE.md).

## Resume point and goal

Latest recorded deployment: iPhone build 14, completed September 29. All 856 manifest files match the audited workspace. Fresh mobile TypeScript and 206 composition tests passed. The user's last installed phone build is working well; detailed device verification remains separate.

Core chat, providers, phone downloads, offline TTS, Personas, memory, archives, automatic context sizing, web retrieval, diagnostics and chat files already have working implementations. Older status documents understate progress.

Continue the original 231-feature, 202-task roadmap, iPhone first. Priority: automatic web research, iOS dictation, then tool settings and MCP. Arena stays held until explicitly resumed; original full-parity gates retain that outstanding dependency.

## Handoff artifacts and operating model

Use CURRENT_STATE.md for facts, PARITY.md for all original IDs, TASK_QUEUE.md for order, PROGRESS.md for durable progress, tasks/ for bounded implementation, and evidence/baseline.json for concise audit receipts.

Read one task and targeted source at a time. Keep working context below roughly 48K tokens even with a 128K window. Preserve modified/untracked application files, current appearance, selected provider/model, secret isolation, voice preferences and file workflows. Do not reimplement already delivered features or claim fixture evidence as device proof.

## First implementation queue

### C01 — Persist automatic web policy

Add saved Auto / Manual / Off modes; Auto is the default, with optional conversation overrides.

- Auto enables research only when the selected model reports tools: yes.
- Models reporting no or unknown keep the existing manual path.
- No extra planning request, substitute model, or provider fallback.
- Offline instructions and explicit per-turn web disablement prevent research.
- Existing search service and opaque credential references survive preference upgrades.

Remove the requirement to enable a chip or say "check web" for capable models. Keep controls to force manual research or disable it.

### C02 — Native model-driven research

Register web_search and web_fetch using existing clients and ToolLoopEngine.

- Tell the model when factual freshness, uncertainty or source-dependent questions warrant research.
- Allow follow-up queries and page reads within the bounded loop.
- Reuse Public search, Brave, existing transports, cancellation and public-URL restrictions.
- Compose web and permitted workspace tools in one registry/loop.
- Retain six rounds, twelve calls and a 300-second loop deadline; limit research to two searches and four page reads per turn.
- Include definitions/results in context budgeting and preserve mandatory instructions and response reservation.
- Store sources as retrieval succeeds; inject deduplicated Source events with strictly increasing sequence and one terminal event.
- Cite retrieved evidence, treat pages as untrusted data, and show retrieval failures without claiming missing evidence was verified.

Add an additive web-mode preference and typed web-tool results. Retain provider and RunEvent contracts.

### C03 — Shared audio ownership

Implement T071 and adapt existing neural TTS.

Add speech-input/output interfaces for availability, language, recognition results, cancellation and disposal. Track idle/listening/transcribing/generating/speaking. Release capture before playback; Stop/interruption must wait for actual resource cleanup. Preserve existing packs, speed and Persona voice bindings.

### C04 — iOS system dictation

Implement T072 using the existing Expo native-module pattern. Add permission descriptions; permission states; recognition language; partial/final text; cancellation and cleanup.

Prefer on-device recognition when supported and identify network-backed recognition. Offline recognition cannot silently use network recognition. Native compilation and physical phone results remain distinct from fixture checks.

### C05 — Dictation in chat

Extend composer and Voice Studio. Preview partial text separately; append final text once; cancellation preserves the original draft. Default to review before sending; autosend is an explicit saved choice.

Handle denied permission, unavailable language, interruption and navigation away. Preserve keyboard layout and TTS controls.

### C06 — General tool settings and built-ins

Finish applicable T066/TL-01 behavior: global/chat/individual tool policy, current time, stable identities separate from labels, and host-bound SecretStore authentication.

Use existing participant > conversation > global precedence. Default tools on for existing authorized workflows; external tools require configuration and enablement. Connect effective settings to the shared web/file registry.

### C07–C09 — External connections

- C07/T064: HTTP MCP discovery/execution, Streamable HTTP, supported legacy SSE, cancellation, scoped auth and unsupported-transport errors.
- C08/T063: SearXNG via the research interface, with configured-service errors and no silent fallback.
- C09/T065: LM Studio integrated names, enablement, native integration references and continuation; unsupported provider integrations stay explicit.

C10 is a bounded tools integration checkpoint, not completion of the original T070 aggregate gate while other dependencies remain unfinished or held.

## Remaining original parity work

| Area                     | Remaining work                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat/model management    | AI summaries, real embeddings/semantic search, imports/runtime mounting, background downloads, native document extraction, math rendering and backend lifecycle controls. |
| Personas/groups          | Generator, model/workflow bindings, memory associations/sharing, participant editor, scheduling, parallel streams and group controls.                                     |
| Voice                    | Whisper, system TTS, cloud voices, automatic reading, transcription playback, continuous/group speech, Call Mode and companion speech.                                    |
| Tools                    | Hosted search, isolated Python/JS, remaining provider replay, transcript presentation and group restrictions.                                                             |
| Media                    | Job engine, A1111, ComfyUI workflows/queues/video, Core ML, gallery and Persona integration.                                                                              |
| Companion/sync           | Routing/UI, encrypted pairing/relay, binary forwarding, convergence/tombstones, selective Persona sync, iCloud and USB.                                                   |
| Personalization/services | Theme editor, appearance controls, lock, encrypted backup, optional accounts/purchases/support/community and analytics consent.                                           |
| Automation/accessibility | Widgets, Live Activities, App Intents, Shortcut recipes, localization, landscape and accessibility.                                                                       |
| Other platforms          | Full iPad/Android/desktop clients, native adapters, packaging and platform evidence.                                                                                      |

Use original cards and preserve each feature's subcontrols. Reconcile a card with current source before coding; implement only the remaining scope. Split aggregate integration checkpoints when necessary, without weakening original release gates.

## Validation and defaults

- PARITY.md contains every original ID exactly once and retains original task and deep-proof mappings.
- Automatic research checks: ordinary questions without chips/search phrases; follow-up search; page reads; non-research answers; disabled/offline modes; unsupported models; cancellation; persistence; exhausted budgets.
- Dictation checks: permissions, partial/final handling, draft preservation, duplicate prevention, cleanup and recognition availability.
- MCP checks: discovery, auth isolation, enablement, rename identity, continuation and cancellation.
- Recheck file tools, context sizing, selected provider and existing TTS after integration changes.
- Focused tests per task; broader checks at integration milestones; physical/live proof stays pending until collected.
- Keep dependency pins. Document the missing pnpm command and direct installed-binary checks; do not rewrite the lockfile for command lookup.
- Skip large weight hash scans by default.
- Handoff authoring changes only this new folder. Application implementation belongs to later Qwen tasks.
