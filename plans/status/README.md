# Remaining work and verification

As of 2026-10-18, inspected at source commit `c559078`. There are **118 active cards** and **84 archived cards**, preserving all 202 original units. This is a document disposition audit, not a new product acceptance run.

Integrated implementation cards are [archived](../../archived/plans/tasks/). Their native, live-service and release proof is still pending in the applicable T158/T128/T159A–H/T160–T169 gates. The old P03–P06 ledgers are [historical snapshots](../../archived/plans/status/), including stale pending/implemented labels. Use the source and rows below for the next action; do not restart completed units.

## P03

| Card | Remaining work |
| --- | --- |
| [T027](../../plans/tasks/P03/T027.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T028](../../plans/tasks/P03/T028.md) | Mount/certify the native MLX bridge; Swift and physical inference proof remain outstanding. |
| [T029](../../plans/tasks/P03/T029.md) | Mac Metal sidecar packaging and real Mac inference remain outstanding; Windows packaging is recorded separately. |
| [T030](../../plans/tasks/P03/T030.md) | Apple Silicon worker build, signed packaging and real inference remain outstanding. |
| [T031](../../plans/tasks/P03/T031.md) | Mount the background URLSession downloader; the app currently uses foreground downloads. |
| [T032](../../plans/tasks/P03/T032.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T033](../../plans/tasks/P03/T033.md) | Complete general imports/Hugging Face and device-backed model lifecycle integration. |
| [T036](../../plans/tasks/P03/T036.md) | Complete MLX/worker/download wiring and real runtime lease/lifecycle integration. |

## P04

| Card | Remaining work |
| --- | --- |
| [T040](../../plans/tasks/P04/T040.md) | Desktop conversation UI ships as the shared Expo web mode inside the Tauri shell (2026-10-19 amendment): static export, streamed chat and native persistence verified in the desktop smoke (`c61292a`, `747c6eb`). Remaining: keyboard/selection spot checks at desktop width (card box 2). |
| [T043](../../plans/tasks/P04/T043.md) | Native PDF/XLSX extraction codecs and complete attachment/runtime integration remain outstanding. |
| [T045](../../plans/tasks/P04/T045.md) | Mount a usable local embedding runtime and certify native FTS/vector indexing. |
| [T047](../../plans/tasks/P04/T047.md) | Native background execution/notification bridge and device lifecycle proof remain outstanding. |
| [T048](../../plans/tasks/P04/T048.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T049](../../plans/tasks/P04/T049.md) | Complete chat integration seams (MLX, embeddings, codecs, rich controls) and native persistence/lifecycle proof. |
| [T158](../../plans/tasks/P04/T158.md) | Physical offline GGUF and live OpenAI first-chat acceptance remain outstanding; build/export alone is insufficient. |

## P05

| Card | Remaining work |
| --- | --- |
| [T054](../../plans/tasks/P05/T054.md) | Finish Persona workflow binding/edit controls; model and voice bindings are already present. |
| [T060](../../plans/tasks/P05/T060.md) | Arena discovery/history/apply UI is held and has no owned implementation. |
| [T061](../../plans/tasks/P05/T061.md) | Mount group transcript/dispatch and Arena UI; Persona/memory paths are already integrated. |

## P06

| Card | Remaining work |
| --- | --- |
| [T067](../../plans/tasks/P06/T067.md) | Register and compose hosted search in API startup; only the optional facade/route module exists. |
| [T068](../../plans/tasks/P06/T068.md) | Register and compose sandbox service in API startup and verify isolated container execution. |
| [T070](../../plans/tasks/P06/T070.md) | Complete tools integration including hosted search/sandbox; the old implemented ledger overstates this gate. |

## P07

| Card | Remaining work |
| --- | --- |
| [T073](../../plans/tasks/P07/T073.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T074](../../plans/tasks/P07/T074.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T076](../../plans/tasks/P07/T076.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T078](../../plans/tasks/P07/T078.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T081](../../plans/tasks/P07/T081.md) | Continuous/group voice and real CallKit lifecycle integration remain outstanding. |
| [T082](../../plans/tasks/P07/T082.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T083](../../plans/tasks/P07/T083.md) | Complete native phone/Mac/group/continuous voice integration; adapters alone do not close this gate. |

## P08

| Card | Remaining work |
| --- | --- |
| [T088](../../plans/tasks/P08/T088.md) | Implement/link Core ML diffusion and eligible-device model execution. |
| [T089](../../plans/tasks/P08/T089.md) | Replace gallery reference placeholders with playable managed image/video preview, save and share. |
| [T090](../../plans/tasks/P08/T090.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T092](../../plans/tasks/P08/T092.md) | Complete Core ML/gallery/Persona image integration and the required working smoke paths. |

## P09

| Card | Remaining work |
| --- | --- |
| [T096](../../plans/tasks/P09/T096.md) | Mount real scanner/manual pairing and connect negotiated encrypted sessions in the phone UI. |
| [T098](../../plans/tasks/P09/T098.md) | Complete two-device sync composition and copy/merge/live-edit convergence proof. |
| [T098A](../../plans/tasks/P09/T098A.md) | Mount paired sync opt-in/initial-choice preferences; package state does not establish the UI. |
| [T098C](../../plans/tasks/P09/T098C.md) | Complete live paired transport/retry/wake integration and visible failure recovery. |
| [T099](../../plans/tasks/P09/T099.md) | Complete selected-Persona/photo/memory sync and unavailable-binding/conflict UI. |
| [T100](../../plans/tasks/P09/T100.md) | Implement native CloudKit transport; shared adapter/queue abstractions are insufficient. |
| [T101](../../plans/tasks/P09/T101.md) | Implement native USB multiplexing and prove Wi-Fi-disabled phone-to-Mac chat. |
| [T102](../../plans/tasks/P09/T102.md) | Complete native tray/startup/sharing/voice-pack controls and host lifecycle wiring. |
| [T103](../../plans/tasks/P09/T103.md) | Complete phone/Mac encrypted relay, tools/binary/sync smoke; USB/iCloud remain separate seams. |

## P10

| Card | Remaining work |
| --- | --- |
| [T105](../../plans/tasks/P10/T105.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T106](../../plans/tasks/P10/T106.md) | Register/authenticate community catalog routes and complete hosted catalog wiring. |
| [T109](../../plans/tasks/P10/T109.md) | Register recovery service and complete device-bound email grant delivery/consumption. |
| [T110](../../plans/tasks/P10/T110.md) | Complete authenticated backup object routes and real restore integration; API startup is health-only. |
| [T111](../../plans/tasks/P10/T111.md) | Complete configured Better Auth, login/linking/reset mail and service startup wiring. |
| [T112](../../plans/tasks/P10/T112.md) | Complete configured products, verified RevenueCat webhook/restore/family transaction integration. |
| [T113](../../plans/tasks/P10/T113.md) | Complete support/update/account-delete backend routes and explicit upload integration. |
| [T114](../../plans/tasks/P10/T114.md) | Complete native WidgetKit/Control Center/ActivityKit extension wiring. |
| [T115](../../plans/tasks/P10/T115.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |
| [T116](../../plans/tasks/P10/T116.md) | Complete reachable App Intents/Share Sheet/CLI invocation; typed contracts alone are insufficient. |
| [T117](../../plans/tasks/P10/T117.md) | Mount workflow entry routes and real OCR/clipboard/Contacts/search/news/voice ports; registry alone is insufficient. |
| [T117A](../../plans/tasks/P10/T117A.md) | Recipe package exists, but reachable workflow routes/native action ports remain outstanding under T117. |
| [T117B](../../plans/tasks/P10/T117B.md) | Recipe package exists, but reachable workflow routes/native action ports remain outstanding under T117. |
| [T117C](../../plans/tasks/P10/T117C.md) | Recipe package exists, but reachable workflow routes/native action ports remain outstanding under T117. |
| [T117D](../../plans/tasks/P10/T117D.md) | Recipe package exists, but reachable workflow routes/native action ports remain outstanding under T117. |
| [T117E](../../plans/tasks/P10/T117E.md) | Recipe package exists, but reachable workflow routes/native action ports remain outstanding under T117. |
| [T117F](../../plans/tasks/P10/T117F.md) | Recipe package exists, but reachable workflow routes/native action ports remain outstanding under T117. |
| [T117G](../../plans/tasks/P10/T117G.md) | Recipe package exists, but reachable workflow routes/native action ports remain outstanding under T117. |
| [T117H](../../plans/tasks/P10/T117H.md) | Recipe package exists, but reachable workflow routes/native action ports remain outstanding under T117. |
| [T119](../../plans/tasks/P10/T119.md) | Complete localization and native accessibility/layout audit; package catalogs do not prove device acceptance. |
| [T119B](../../plans/tasks/P10/T119B.md) | Later Android/iPad/desktop platform implementation and its native acceptance remain outstanding. |

## P11

| Card | Remaining work |
| --- | --- |
| [T121](../../plans/tasks/P11/T121.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T122](../../plans/tasks/P11/T122.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T123](../../plans/tasks/P11/T123.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T124](../../plans/tasks/P11/T124.md) | Unsigned MSI + NSIS build locally and the CI build skeleton exists (`4a145e6`, `1c473e8`); release acceptance still needs signed/notarized artifacts with a named external credential owner. |
| [T125](../../plans/tasks/P11/T125.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T126](../../plans/tasks/P11/T126.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T127](../../plans/tasks/P11/T127.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T128](../../plans/tasks/P11/T128.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T129](../../plans/tasks/P11/T129.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T130](../../plans/tasks/P11/T130.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T131](../../plans/tasks/P11/T131.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T132](../../plans/tasks/P11/T132.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T133](../../plans/tasks/P11/T133.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T134](../../plans/tasks/P11/T134.md) | Windows milestone proven end-to-end 2026-10-19: full smoke passes against the release exe and the per-user silent-installed exe (`c61292a`, `4a145e6`); restart persistence proven via native SQLite rows + Windows Credential Manager (`747c6eb`); archive import automated end-to-end and the native save dialog proven to surface (`35a0014`). Remaining: macOS/Linux shells (T164/T166) and the QR/iPhone-companion box. |
| [T135](../../plans/tasks/P11/T135.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T136](../../plans/tasks/P11/T136.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T137](../../plans/tasks/P11/T137.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T138](../../plans/tasks/P11/T138.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T139](../../plans/tasks/P11/T139.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T140](../../plans/tasks/P11/T140.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T141](../../plans/tasks/P11/T141.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T142](../../plans/tasks/P11/T142.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T143](../../plans/tasks/P11/T143.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T144](../../plans/tasks/P11/T144.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T145](../../plans/tasks/P11/T145.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T146](../../plans/tasks/P11/T146.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T147](../../plans/tasks/P11/T147.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T148](../../plans/tasks/P11/T148.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T149](../../plans/tasks/P11/T149.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T150](../../plans/tasks/P11/T150.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T151](../../plans/tasks/P11/T151.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T152](../../plans/tasks/P11/T152.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T153](../../plans/tasks/P11/T153.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T154](../../plans/tasks/P11/T154.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T155](../../plans/tasks/P11/T155.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T156](../../plans/tasks/P11/T156.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T157](../../plans/tasks/P11/T157.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159](../../plans/tasks/P11/T159.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159A](../../plans/tasks/P11/T159A.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159B](../../plans/tasks/P11/T159B.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159C](../../plans/tasks/P11/T159C.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159D](../../plans/tasks/P11/T159D.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159E](../../plans/tasks/P11/T159E.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159F](../../plans/tasks/P11/T159F.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159G](../../plans/tasks/P11/T159G.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T159H](../../plans/tasks/P11/T159H.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T160](../../plans/tasks/P11/T160.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T161](../../plans/tasks/P11/T161.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T162](../../plans/tasks/P11/T162.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T163](../../plans/tasks/P11/T163.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T164](../../plans/tasks/P11/T164.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T165](../../plans/tasks/P11/T165.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T166](../../plans/tasks/P11/T166.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T167](../../plans/tasks/P11/T167.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T168](../../plans/tasks/P11/T168.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |
| [T169](../../plans/tasks/P11/T169.md) | Working-build, platform, deep-verification or release acceptance remains outstanding; retain the full card and its evidence requirements. |


## P12

| Card | Remaining work |
| --- | --- |
| [T170](../../plans/tasks/P12/T170.md) | Implemented `ace67ef`. Migration 0009 side tables (settings, Drunk prefs, rounds, runs, group-conversation mapping; `trigger_kind` not `trigger`), stable seat IDs, settings round-trip + validation, round/run storage API. No core-table ALTERs (card amended). Check: schema 20, groups 21, mobile group vitest 7, chat-composition 286, typecheck. |
| [T171](../../plans/tasks/P12/T171.md) | Implemented `1698783`. Catalog `liquid/lfm2.5-2.6b-q4_k_m` pinned (revision e7caca5d…, sha256 02a8b7e1…, 1674455040 B, LFM Open v1.0); native top_k/penalty_repeat forwarding + conditional penalty_last_n; capabilities; publisher sampling folded under user scopes at model level. Check: models 8, gguf-ios 34, chat-settings 5, capabilities 5, models-ui 5, composition 286, typecheck. Device proof T179. |
| [T172](../../plans/tasks/P12/T172.md) | Implemented `91c8679`. `SendInput.participantId` seat attribution (solo passes null, unchanged); `ChatEngine.beginAssistantRun` inserts only an attributed assistant row (no user row) and runs row, streaming through the unchanged durable pipeline; `GroupRoundActiveError` guard at the core seam (`beginGroupRound`/`endGroupRound`/`isGroupRoundActive`; `send()` rejects inside a round; `beginAssistantRun` requires the guard); `AdvancedChatEngine.beginAssistantTurn` packs upstream-prepared context via packContext (required group instruction kept, titling skipped, contextUsage returned). Projection needed no change (participantId already plumbed). Round/run writer from T170 verified unchanged (`finishSpeakerRun` = card's `completeSpeakerRun`). Check: core 7->10, advanced 3->5, groups 10+7+4, storage 2+3+3 (chain pin bumped 8->9), projection 7, composition 286, typecheck. |
| [T173](../../plans/tasks/P12/T173.md) | Implemented `b3d92e7`. turns: `roundRobinOrder(cursor)`, `diceOrder` (mulberry32-seeded Fisher-Yates, seed saved with round), `topicInterestPrompt`/`parseTopicInterestOrder`/`planTopicInterestOrder` — one json_object selector call, strict validation (every seat exactly once, finite scores, desc + seating tie-break), seating-order fallback, never retried, abstain-floor idea kept as source comment; `contextMode` discussion/independent in plan + `runGroupUserTurn` (independent = same frozen `priorTranscript` for all), Pass = optional `userText`. mobile: `group-context.ts` `applyDrunkWindow` (~512 est. tokens length/4, newest-first, persona/room/current pinned, compacted excluded, pre-`packContext`, stored history untouched); mobile depends `@locallab/groups-turns`. Check: groups-turns 7->16, composition 286->290, groups-config 10, groups-parallel 4, typecheck. |
| [T174](../../plans/tasks/P12/T174.md) | Implemented `9dca638`. parallel: `withModelLease`/`leasedTurnPort`/`RoomLeaseOptions` — all room generation traffic (seat replies + topic-interest selector) through one capacity-1 host slot reusing FIFO/abortable waiters, no second scheduler. mobile `group-runtime.ts`: `resolveSharedRoomBinding` (one binding per room; per-seat model fields kept but ignored when shared binding resolves), `groupModelKey`, `GroupModelRuntime` (capacity 1, active reserved pre-acquire so release waits for queued waiters, schedule blocked while releasing, `release()` quiesces then unloads exactly once incl. concurrent calls, reusable after). Isolated failure policy: provider error → runs row failed, round continues; lease/load failure aborts round, no silent substitution; no gguf/ios hooks needed (refcounted `ManagedModelFiles`). turns: restored `GroupContextMode` declaration missing from T173. Check: groups-parallel 4->7, composition 290->293, turns 16, gguf-ios 34, generation-lifecycle-ios 5, typecheck. Device memory/thermal proof T179. |
| [T175](../../plans/tasks/P12/T175.md) | Implemented `681f545`. core: `appendUserMessage(conversationId,text,userParts?,participantId?)` inserts one attributed user row, run_id NULL, returns message id (guard like `begin()`). advanced: `AdvancedAssistantTurnInput.json` forwarded to `core.beginAssistantRun` (topic-interest selector); selector's unattributed assistant row filtered from transcript at the route. mobile `group-driver.ts`: `GroupTurnDriver.startTurn` (Send/Pass/Ask) — user row, guard `beginGroupRound` before selector, one seat at a time via `GroupModelRuntime.schedule`, stop state resets per turn (`stopCurrent` sets stopping first; schedule callback stops freshly-started run if stop landed mid-begin), seat instruction = scenario+persona+systemPrompt+`DRUNK_STYLE`, presenter onStatus/onEntry/onDelta, live-mode stopped-seat text marked `(interrupted)` by route; `group-chat-route.tsx` boots room/engine/local binding/`GroupModelRuntime(capacity 1)`, transcript loader skips `participant_id IS NULL` assistant rows, reopening marks stale round stopped (notice, never auto-resume), AppState background releases model; route `app/group-chat.tsx`; setup screen Open-room buttons wired to `router.push /group-chat`. Card deviation: driver behavior tests in composition (8 tests) not feature file. Check: chat-engine-core 11, chat-engine-advanced 5, composition 293->301, group features 7, typecheck green. Device proofs T179. |
| [T176](../../plans/tasks/P12/T176.md) | Implemented `18fca06`. setup panel: Room settings block with plan names — Conversation (Discussion/Independent), Turn order (Round robin/Dice roll/Topic interest), Reply display (Complete replies/Live text), Shared model picker (`groupModelChoices` → `blob:<blobId>`, no-selection room defaults to first installed recommended entry via guarded effect; explicit "" = null kept), Response limit numeric 16-4096 (default 256 via `defaultGroupRoomSettings`); per-seat `Switch` "Drunk - only remembers the last few messages in this room"; composition fetches `listInstalledModels()` when groups panel opens, Save + saved-room rows navigate `/group-chat`. Card deviation: 390px web-preview pass impossible (panels don't render on web without native runtime; no DOM render harness) — visual pass folded into T179 device screenshots. Check: group-setup 4->6 (settings+drunk persist via saveRoom/loadRoom, blob: mapping), composition 301, typecheck green. |
| [T177](../../plans/tasks/P12/T177.md) | Implemented `d03f23a`. `LibraryConversation` gains `kind` ('solo'|'group'), `avatarAttachmentId`, `personaPhotoAttachmentId`: kind via LEFT JOIN on `group_room_conversations`, chat photo from `chat_appearance`, persona photo from `conversation_personas`+`persona_profiles.photo_attachment_id`. Card ground truth false — T170 has no `group_rooms.avatar_attachment_id` and `conversations` has no kind column; room avatars ride `chat_appearance` keyed by the room's own conversationId (`markGroupConversation` mapping), no schema migration; library SELECT hard-depends on mobile-initialized cross-feature tables (library tests stub them). `ChatAppearance.avatarAttachmentId` round-trip + settings photo block (choose/replace/remove; previous photo released only after durable save confirmed). `createManagedPersonaAvatarPort` optional `validateOwnerId` (default `EntityIdSchema.parse`; composition accepts bare UUID or scoped `chat-avatar:<conversationId>`, persona UUID guard unchanged). Solo header chain custom photo > persona photo (non-default persona) > initials; history rows photo/group-icon/initials, images decorative a11y; group room header photo + transcript/live/seat per-seat persona photos via route-resolved `seatAvatars`. New script `test:personas-avatars` wires orphan `features/personas` tests (formal CI matrix = T178). Check: conversation-library 5, chat-settings 5, personas-avatars 3, personas 5, attachments 5+2, group features 9, chat-composition 301→303 (appearance round-trip extended; lifecycle refcount: replacing `chat-avatar:<id>` keeps the `persona-run:` lease readable, last release deletes exactly; driver: prepared seat prompts carry persona text, no UUID token of any kind), mobile+root typecheck green; group avatar visuals fold into T179 device pass (no RN render harness). |
| [T178](../../plans/tasks/P12/T178.md) | Queued; depends T170-T177. Coverage matrix, test:groups wiring, docs truth. |
| [T179](../../plans/tasks/P12/T179.md) | Queued; physical iPhone 17 Pro Max required — benchmark + Liquid device proof cannot run from Windows. |

> 2026-10-19 desktop note: the T134 feature dependencies T136–T156 are served to the desktop client by the shared Expo web set inside the Tauri shell (T040/T134 amendments, `plans/07`); the desktop smoke exercises onboarding, providers, composer, streaming, diagnostics routing and restart persistence at desktop width, but per-feature desktop-width evidence is still owed by the deep-verification shards. The voice/audio path (T133) is not bridged on desktop and unexercised.

Record new checks with the [evidence template](TEMPLATE.md). Full disposition and move hashes are in the [cleanup audit](../../archived/cleanup-2026-10-18.json).
