# App workflow completion audit — 2026-09-27

## Decision and scope

**Browser verified within the stated scope; physical-device validation pending.**
The user goal is not marked complete. The expanded full browser run
contained 31 scenarios across two viewport projects, **62 checks**, and finished
with **61 passed, one failed**. The desktop failure found a Provider-save/Settings
navigation race. The source changed after that case, making this a mixed source
snapshot. Four focused current-source context/Memory checks passed after the fix,
with no skipped, unexpected or flaky checks and exit `0`.
A fully green consolidated result will be claimed only if a new full run
establishes it. The new attachment/PDF scoped checks have passed. The earlier
**36/36** run is a successful historical snapshot, before the additional
workflow checks and fixes described here. It is not the result of the expanded
suite or proof of a current iPhone binary.

The goal under review is to exercise the implemented app through its rendered
controls, resolve material failures, and leave the local OxCoder provider
configured for useful chat. This audit covers the currently mounted Expo screens.
The [feature inventory](../../../../docs/lm-mini-features.md) and task roadmap describe a
larger product; an implemented package or fixture does not establish a mounted,
usable feature.

The local evidence uses the shared Expo application in installed Google Chrome
on Windows. Desktop means a `1280 × 900` browser viewport. Phone means Chromium
with iPhone 13 viewport emulation, not physical iOS or Safari. Playwright replays
clicks, typing, chooser actions, downloads, scrolling and reloads against the
rendered app. Separate screenshots and a real response in the dedicated browser
profile establish the configured handoff. This is narrower than a physical-device
manual pass.

## Browser validation receipts

| Run                                  | Observed result                                                                                                                                                                                                                    | Source and evidence boundary                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial expanded full run            | [Report](../../../../tmp/app-workflow-audit-full-ui/report.json); start `2026-09-27T19:58:03.073Z`; duration `1398.031573` seconds (`1398031.573` ms); expected/pass `61`, unexpected/fail `1`, skipped `0`, flaky `0`; exit `1`      | Mixed source snapshot: the desktop Provider Save → Settings race was fixed during the run. All `31` phone checks passed. This is not a clean current-source `62/62` result                                        |
| Focused affected flows after the fix | [Report](../../../../tmp/app-workflow-audit-provider-race-fixed/report.json); start `2026-09-27T20:21:38.922Z`; duration `96.829248` seconds (`96829.248` ms); expected/pass `4`, skipped/unexpected/flaky `0`, errors `[]`; exit `0` | Frozen source with conditional Provider close. Real context and edited sourced-Memory passed on desktop and phone. The coordinator visually inspected desktop source and phone retry/current-response screenshots |
| Historical smaller full run          | [Report](../../../../tmp/full-local-ui-validation-final/report.json); start `2026-09-27T19:13:25.203Z`; duration `275.415821` seconds; `36/36`, skipped/unexpected/flaky `0`; exit `0`                                                | Earlier suite and source snapshot; does not replace the expanded result                                                                                                                                           |

## Current mounted routes and screens

The inventory below comes from [app routes](../../../../apps/mobile/app),
[Chat composition](../../../../apps/mobile/composition/chat/screen.tsx), and
[Chat panels](../../../../apps/mobile/composition/chat/panels.tsx).

| Mounted path or surface        | Current behavior                                                                                                               | Evidence boundary                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                            | Opens the durable onboarding state, then redirects to onboarding or chat; exposes a storage error and Retry when startup fails | Rendered initial entry, reload and two-tab recovery; the web Retry obtains a fresh SQLite worker                                         |
| `/onboarding`                  | Beginner/Power user choice, immediate theme preview, model recommendations, Continue without a model                           | Rendered choices and persistence; browser capacity is unknown and suggested local download is unavailable                                |
| `/chat`                        | Transcript, rich Markdown, composer, provider selection, Stop, New chat, and panel navigation                                  | Real local server responses plus fixture cases; database and managed bytes use the production browser adapters                           |
| `/connections`                 | Saved connection CRUD/order, headers and credentials, explicit connection tests, links to Models and chat                      | Rendered fixture inventory/requests and durable reopen; LAN scanning is unavailable in the browser                                       |
| `/models`                      | Catalog and selected remote server inventory; exact model/server selection; supported remote lifecycle controls                | Rendered model binding and fixture Ollama cancellation/deletion; no main-screen GGUF file import                                         |
| Chat → Library                 | Saved conversations and folders, search, move/rename/color/delete, source reopening                                            | Rendered SQLite persistence, confirmations and imported/saved history                                                                    |
| Chat → Settings                | App theme; Global/Model/Persona/Chat parameter scopes; appearance; context policy and retry                                    | Rendered scope/reset/typing/persistence; real Roll/Cut middle request projection and saved-user retry                                    |
| Chat → Search                  | Local saved title and visible-message search, all chats/current chat, exact source navigation                                  | Current scoped `4/4` on imported/SQLite data, selected variants, source layout and continuation                                          |
| Chat → Providers               | Saved provider setup, exact model ID, explicit HTTP-origin authorization, Test connection, Save and use provider               | Real local inventory and chat; cloud provider coverage uses labeled fixtures                                                             |
| Chat → Personas                | Profile CRUD, selection/current-chat switch, individual chat, managed avatar, appearance                                       | Rendered profile/avatar cases and real history-preserving Persona replies; Add to group is disabled                                      |
| Chat → Memory                  | Explicit injection/extraction consent, manual fact CRUD/search, sourced facts and source navigation                            | Real consented extraction and fixture/store regressions; further source/edit boundaries are tracked below                                |
| Chat → Archives                | LM Studio import, TXT/PDF export, all-chat ZIP export/import, Back to chat                                                     | Actual browser choosers/downloads and persistent byte round trips                                                                        |
| `/dev/primitives`, `/dev/gguf` | Developer fixture/probe routes reachable by URL, outside the normal workflow navigation                                        | Primitives are a fixture; web GGUF only explains native requirements. The native probe requires a managed model, hash and build identity |

There are no separate `/library`, `/settings`, `/search`, `/personas`, `/memory`
or `/archives` routes. These are mounted Chat panels. Group and Arena packages
do not produce a mounted group/Arena workflow in the current app.

## Requirement and evidence table

Results in this table are scoped evidence or the historical full-run result.
They must not be added together as a new full-suite total. Fixtures are labeled
and are not claimed as model inference or live cloud-provider proof.

The initial expanded run failed in the real sourced-Memory scenario before
generation: **Settings** was clicked about `52` ms after Provider Save dispatch,
while the database save was still pending. The late Provider `onClose` set the
current panel to null, closing the newly opened Settings before **Global** could
be selected. The trace contains the model-inventory GET and no Chat POST, so this
failure does not assess Memory extraction/model quality. The root now closes only
the still-current Providers panel through a functional state update. The test is
not masked by a longer wait. The failure and first-run report are retained.
Current-source focused real context/Memory checks on both projects passed `4/4`.
The replacement iOS JavaScript/Hermes export has passed with the conditional-close
fix included; it does not establish a signed or installed native binary.

| Required workflow                                                    | Concrete proof available                                                                                                                                                                                                                                           | Result and remaining limit                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter chat, choose setup style, apply/persist themes                 | [Onboarding scenarios](../../../../tests/ui/onboarding.spec.ts) exercise rendered Beginner/Power and Light/Dark choices, immediate theme changes and reload; current root uses a themed safe-area wrapper                                                             | Historical rendered pass plus current System color-scheme boundary pass. Physical camera-cutout spacing remains unproven                                                                                                                                    |
| Bind a real provider and exact model                                 | [Live chat](../../../../tests/ui/live-chat.spec.ts), saved provider/model choices, real local inventory test, and [configured profile requests](../../../../tmp/configured-local-preview/requests.json)                                                                  | Actual `local-coder` chat and reload verified; paid/cloud providers use fixtures and no live cloud account proof is claimed                                                                                                                                 |
| Produce a visible useful answer, stop and continue                   | Actual Helix and Python replies; actual stream Stop, retry without a duplicate user row, new chat and persisted transcript                                                                                                                                         | Historical live pass plus current real code-copy `2/2`; output-limit status is distinct from a completed answer                                                                                                                                             |
| Recover after reload/background interruption                         | [Recovery scenarios](../../../../tests/ui/generation-recovery.spec.ts) preserve saved partial text, persist terminal cancellation and allow a new real response; another live tab remains protected                                                                   | Historical `4/4`; OPFS permits one open tab per profile. The test closes the first tab, then retries opening chat in the second. Native lifecycle behavior is a separate gate                                                                               |
| Follow the latest reply while preserving manual reading/source focus | [Long-history scroll scenarios](../../../../tests/ui/transcript-scroll.spec.ts) import real history, reopen at the latest reply, scroll upward, resize and use Latest                                                                                                 | Historical `2/2`; current Search `4/4` also verifies source visibility and fresh-response follow after an additional phone fix                                                                                                                              |
| Use composer modes, starters and actual keyboard behavior            | [Composer scenarios](../../../../tests/ui/composer-interactions.spec.ts) persist Shine/Compact, starters and Return preference; actual Enter/Shift+Enter; meaningful starter payload; exactly one send                                                                | Scoped desktop and phone keyboard checks passed. Native hardware modifier behavior is not inferred from Chrome                                                                                                                                              |
| Copy the original Markdown and report denied writes                  | Exact fenced/indented/Unicode source is passed to the real Clipboard API; Windows clipboard read is compared after CRLF normalization; actual browser permission denial shows an actionable error                                                                  | Scoped fixture `2/2` plus actual model fenced-code `2/2`; no production clipboard reads                                                                                                                                                                     |
| Use context compaction and retry without losing history              | [Real context scenarios](../../../../tests/ui/context-recovery-live.spec.ts) capture actual Roll/Cut middle request projections, keep the final user turn once, and export original history after reload                                                              | Earlier scoped `2/2` with saved TXT/screenshots; post-navigation-fix context `2/2` within the [focused `4/4` report](../../../../tmp/app-workflow-audit-provider-race-fixed/report.json). Summary generation remains unavailable                               |
| Manage saved connections, Models and Library                         | [Rendered scenarios](../../../../tests/ui/library-connections.spec.ts) check CRUD/order/header replacement, exact model/server binding, linked connection changes/deletion, folders and confirmed deletion                                                            | Historical `8/8`; remote lifecycle responses are fixtures, not an actual Ollama model download                                                                                                                                                              |
| Attach files and preserve originals                                  | [Attachment/archive scenarios](../../../../tests/ui/attachments-archives.spec.ts) use a real UTF-8 file in an actual local request, verify the primary flower answer, round-trip ZIP bytes and remove invalid/unextractable originals                                 | Historical `4/4` plus current boundary `6/6`: cancellation branch, sequential/remove/original-byte retention, bounded text notice and unverified-vision refusal/recovery. PDF/XLSX text extraction and native pickers/camera remain unproven or unavailable |
| Export/import saved chats safely                                     | Actual TXT/PDF/ZIP downloads, multi-page Unicode PDF inspection, ZIP reimport/reload, malformed JSON/ZIP rejection                                                                                                                                                 | Current mixed user/assistant fenced-code TXT and two-page Unicode PDF were downloaded and visually verified in both projects; browser PDF is rasterized and not searchable. Native share-sheet behavior remains unproven                                    |
| Manage Personas without changing the saved conversation              | [Supporting panels](../../../../tests/ui/supporting-panels.spec.ts) and [boundaries](../../../../tests/ui/persona-memory-boundaries.spec.ts) exercise CRUD, avatars, selection, launch and reload; real requests preserve earlier history and apply the selected Persona | Host/availability scoped `4/4`; theme/avatar/search boundaries `6/6`; real edited sourced-Memory navigation desktop and phone passed. Group dispatch remains unavailable                                                                                    |
| Respect Memory consent, source and deletion                          | Real local extracted Helix preference, exact user quote and Open source; manual CRUD/search; injection/extraction consent; selected-Persona isolation; focused tombstone/drain/transaction checks                                                                  | Historical live `2/2` plus current real edit/cross-chat source pass on both projects; source quote remains intact. Deleted-source/legacy pagination and general extraction quality remain unproven                                                          |
| Search saved public text and open the exact source                   | [Search scenarios](../../../../tests/ui/search-panel.spec.ts) use actual imports, selected/unselected variants, literal `%`/`_`/apostrophe, blank/no-results/current-chat cases, and source highlighting after reload                                                 | Current scoped `4/4`; old variant/base text, reasoning and tool text are excluded while exported variants remain saved. Exact source and fresh-response viewport assertions pass                                                                            |

## Critical fixes and scoped proof in this audit turn

| Fix                                                       | Why it was needed                                                                                                                                                                             | Current proof                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real context policy/retry wiring and settings persistence | Controls had to change the actual request projection while retaining original saved history and user identity                                                                                 | Earlier `2/2` [context report](../../../../tmp/context-recovery-live-ui-final/report.json), duration `55.732809` seconds, zero skipped/unexpected/flaky, with original-history TXT and captured request projections. Context passed again on both projects within the frozen-source focused `4/4` follow-up                                                                                                                                        |
| Mounted Copy callback and platform clipboard adapters     | The rich renderer supported a callback but the Chat host did not supply it, leaving Copy unreachable                                                                                          | Exact original source, real success and real denied permission are exercised by the new composer checks                                                                                                                                                                                                                                                                                                                                         |
| Explicit composer checked states                          | The pinned React Native Web renderer did not map the existing `accessibilityState.checked`; selected controls were exposed as unchecked                                                       | Desktop/phone radios and switches now expose `aria-checked`; rendered tests assert the checked state and saved values                                                                                                                                                                                                                                                                                                                           |
| Preference load admission                                 | An early phone Compact selection was overwritten by the asynchronous initial preference load                                                                                                  | Controls wait for that load. The failing phone keyboard case passed after the fix in [hydration artifacts](../../../../tmp/composer-interactions-hydration-fixed-results)                                                                                                                                                                                                                                                                          |
| Busy Attach/Dictate state                                 | Attach looked enabled during generation although its handler returned without opening a chooser                                                                                               | Held provider fixture asserts Attach disabled while pending and enabled after completion                                                                                                                                                                                                                                                                                                                                                        |
| Aggregate attachment extraction notice                    | Two 40,000-character originals were bounded to 40,000 + 24,000 extracted characters in the actual fixture request without a visible truncation notice                                         | Independent polite notice after admission is verified in current boundary `6/6`; original bytes remain complete in ZIP after send/reload, removed bytes are absent, and later ordinary send/New chat clear the notice                                                                                                                                                                                                                           |
| Native TextInput submission behavior                      | Native submission needed an explicit React Native `submitBehavior`, while the pinned web renderer still uses `blurOnSubmit`                                                                   | Native source uses submit/newline; actual Chrome Enter/Shift+Enter checks pass. Physical native hardware-keyboard behavior remains unproven                                                                                                                                                                                                                                                                                                     |
| Persona host refresh and availability                     | Current selected-profile edits/deletion needed host refresh; Default Persona scope and group actions needed accurate availability                                                             | Rendered host/availability `4/4` in [scoped artifacts](../../../../tmp/supporting-persona-settings-availability); mobile typecheck passed                                                                                                                                                                                                                                                                                                          |
| Search source visibility and Latest layout                | Additional source checks found a Latest overlap and insufficient phone source visibility                                                                                                      | Current `4/4` in [final Search report](../../../../tmp/search-panel-completion-final-results/report.json): in-flow Latest, focused-source layout and Send clearing focus/resuming latest follow; both source and fresh reply meet 90% viewport assertions                                                                                                                                                                                          |
| Native AbortController compatibility                      | The installed React Native 0.86 abort-controller 3 lacks `AbortSignal.throwIfAborted()` and abort-reason retention; Expo winter patches static APIs only, while Chrome supplies these methods | The avatar picker passes a controller and Memory extraction requires signals, so those mounted native paths reach the missing method. Native [compatibility](../../../../apps/mobile/platform/abort-compatibility.ts) is installed before first render, with a web no-op. Focused actual-installed-constructor/Expo static-any checks pass `2/2`; mobile typecheck/format pass. Physical execution and the earlier startup cause remain unresolved |
| Native Device imports                                     | Current native capacity/probe source must use the Expo Device namespace export rather than a nonexistent default export                                                                       | Current source is corrected in [device capacity](../../../../apps/mobile/platform/device-capacity.ts) and [native probe](../../../../apps/mobile/app/dev/gguf.tsx), and included in submitted build `2`. Native compilation passed in build 2; physical execution remains pending                                                                                                                                                                     |
| Late Provider Save panel close                            | A pending Provider save's late callback closed Settings after a fast navigation; no Chat POST occurred in the failed scenario                                                                 | Root now closes only a still-current Providers panel through a functional update. The original failure is retained; frozen-source real context/Memory follow-up passed `4/4` across desktop and phone. The final release iOS export includes the fix and passed                                                                                                                                                                                 |

The final Search scoped report started `2026-09-27T19:39:47.199Z`, lasted
`95.162338` seconds and passed `4/4` with no skipped, unexpected or flaky checks
and exit `0`. It supersedes the earlier source-layout rerun that passed desktop
but failed phone. The phone source and continuation screenshots were visually
inspected; source headers, primary text and Latest remain separated. These cases
use labeled archive/provider fixtures and real app persistence, not model calls.

The additional theme/Memory boundary run found two material failures: System
theme did not consistently subscribe to browser color-scheme changes, and a
stale Memory reload could replace literal search results. Both source fixes
passed the scoped non-live `6/6` run in
[boundary artifacts](../../../../tmp/persona-memory-boundaries-fixed), including
actual browser preference changes, cleared initials, avatar chooser/editor
cancellation and managed-byte cleanup, and literal `%`/`_` search.

The new real sourced-Memory case passed desktop in
[desktop live artifacts](../../../../tmp/persona-memory-boundaries-live) and phone
in [final phone artifacts](../../../../tmp/persona-memory-boundaries-live-phone-text),
with the final phone case taking `27.6` seconds. It makes one actual chat request
and one extraction request, edits the fact without changing its source quote,
opens that source from another chat after reload, and asserts the original source
paragraph is at least 90% visible. Captured requests and the final screenshot are
saved beside the case. Earlier phone checks measured larger wrappers that include
Copy controls and failed; those artifacts remain in the earlier live and
`tmp/persona-memory-boundaries-live-phone-primary` directories. The final test
uses the primary source paragraph and retains the visibility ratio. Source
removal has no mounted chat-delete action; unavailable-source/legacy review,
large Memory pagination and Memory import are not established by this fresh-profile
flow. The expanded full run is recorded separately with its one pre-fix navigation
failure; the frozen-source affected-flow follow-up then passed `4/4`.

The clipboard/composer scoped evidence totals **six checks across two viewport
projects**, assembled from the keyboard/preference, real denied-write/busy-attach,
and actual model code-copy cases. Artifacts are
[fixture results](../../../../tmp/composer-interactions-final-fixture-results),
[phone hydration rerun](../../../../tmp/composer-interactions-hydration-fixed-results),
and [real code-copy results](../../../../tmp/composer-interactions-live-results).
The final phone hydration rerun is the successful replacement for the earlier
phone failure. Mobile typecheck passed after these source changes. The coordinator
also reports an earlier typecheck pass for all 53 configured projects, followed
by mobile typecheck passes after native compatibility and the Provider-close fix. These are
source/type checks, not additional browser or native-device passes.

## OxCoder handoff configuration

| Setting                             | Verified value                                                            |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Provider                            | Compatible local llama.cpp server                                         |
| Endpoint                            | `http://127.0.0.1:35961/v1`                                               |
| Exact model ID                      | `local-coder`                                                             |
| Server context reported by metadata | `16384`                                                                   |
| Saved LocalLab Model context window | `16384`                                                                   |
| Saved maximum output tokens         | `2048`                                                                    |
| Saved model System prompt           | Exact text below                                                          |
| Persistent profile                  | `tmp/locallab-preview-profile/`, opened by `tools/open-local-preview.ps1` |

```text
<|think_off|>
You are a helpful coding assistant. Give clear, concise answers and working code when asked.
```

[The configured real Python reply](../../../../tmp/configured-local-preview/configured-real-chat.png)
contained `def add(a, b):` and `return a + b`. Its
[captured request](../../../../tmp/configured-local-preview/requests.json) used the
exact model and `max_tokens: 2048`; reload retained the provider, settings and
transcript. This profile proof is independent of the isolated test contexts.

The loaded OxCoder template recognizes `<|think_off|>`; this is model-specific
configuration, not a general guarantee for other models. Thinking-mode requests
had sometimes exhausted their budget without a primary answer. Live short-answer
tests use the actual System prompt setting. Memory extraction receives only the
trusted template marker before its own extraction/JSON instructions.

The preview relay permits only explicitly configured provider origins, streams
actual upstream bytes and propagates cancellation. It addresses this server's
browser CORS restriction. Native fetch remains direct. The loopback address is
for this Windows machine; physical iPhone access requires a reachable LAN address
or appropriate private tunnel. See the [local guide](../../../../docs/local-ui-testing.md).

## Visible availability and unresolved coverage

| Action or platform                                | Current explanation or boundary                                                                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suggested onboarding download                     | Disabled: no verified model artifact/download adapter is configured; Continue without a model works                                                                                                         |
| Main Models GGUF import / browser local inference | Import is explicitly unavailable in Models; the web local port returns an unsupported result, never fake inference                                                                                          |
| LAN discovery                                     | Explicitly unavailable on web; native permission/discovery behavior needs a device pass                                                                                                                     |
| Semantic search                                   | Disabled without an installed local embedding model/index; saved ordinary-text search remains usable                                                                                                        |
| Composer internet Search                          | Disabled with `Web search is not available in this build.`; this is separate from local saved-chat Search                                                                                                   |
| Summary context compaction                        | Disabled with an explanation; Roll/Cut middle and saved-user retry have actual request proof                                                                                                                |
| Add Persona to group                              | Disabled with `Group chats are not available in this build.`; individual chat/current-chat selection work                                                                                                   |
| PDF/XLSX attachment extraction                    | Actionable retained-original error; working Remove allows recovery. An exported PDF does not establish PDF text extraction                                                                                  |
| Browser secrets and simultaneous tabs             | Keys live in tab memory and require re-entry after reload. OPFS permits one open app tab per profile; a second tab gives an actionable close-and-Retry path                                                 |
| Native GGUF and Apple ML                          | Browser unavailable. AppleMLProbe native inference still reports `ENGINE_NOT_LINKED`; a linked pod alone is not inference proof                                                                             |
| Other roadmap surfaces                            | Arena, group dispatch, tools/MCP management, voice/dictation, camera/photo composer, media generation, sync/pairing and native desktop/companion workflows are not established by this mounted-screen audit |

The new [attachment boundary scenarios](../../../../tests/ui/attachments-boundaries.spec.ts)
passed **6/6**, exit `0`, with no skipped, unexpected or flaky checks. The
[scoped report](../../../../tmp/attachment-boundaries-verified-final-results/report.json)
started `2026-09-27T19:56:02.806Z` and lasted `89.429901` seconds. The scenarios
exercise sequential originals, a third attachment's removal, the actual transient
picker input's cancel notification with unchanged draft/history, unknown-vision
refusal before provider contact, removal/recovery, and the 64,000-character text
bound with complete originals retained in ZIP after send/reload. Later ordinary
send and New chat clear the shortening notice. Provider output in these cases is
explicitly a fixture; no model inference is claimed.

Actual mixed user/assistant fenced-code TXT and two-page PDF downloads were
inspected. The extracted PDF JPEG pages were visually complete in both projects,
including café, 日本語, indentation, code lines 01–65 across the page break and the
end marker. Matching rasters were also checked with `pdftotext`, which accepted
the PDF and returned no selectable text. Browser PDF remains readable raster/raw
Markdown rather than searchable PDF text. Native print/share and physical OS
Escape cancellation remain separate device evidence. The expanded 62-check run
completed with one pre-fix navigation failure, as recorded above.

## Native and completion gates

The first signed preview build
[`36004774-e40b-4a1f-a4b7-3e5b598d4fef`](https://expo.dev/accounts/barrett/projects/locallab/builds/36004774-e40b-4a1f-a4b7-3e5b598d4fef)
compiled, signed and uploaded successfully with AppleMLProbe and llama.rn. The
user installed that earlier binary and reported ineffective theme/setup controls,
camera-cutout overlap and failure to enter chat. Reinstallation subsequently
failed without an error; its cause is unresolved. These are historical facts
recorded in the [iPhone guide](../../../../docs/iphone-installation.md), not successful proof
of the changed source.

The coordinator's pre-submission read-only EAS account usage check reported the Free
plan, iOS builds `1/15`, total builds `1/30`, estimated cost `0` and overage `0`.
The consumed build at that checkpoint was the earlier signed preview. This is
not a post-submission quota receipt.

Fresh iOS preview build
[`34eb8beb-267d-4688-b069-6f85c04069d7`](https://expo.dev/accounts/barrett/projects/locallab/builds/34eb8beb-267d-4688-b069-6f85c04069d7)
was submitted successfully with exit `0`, created `2026-09-27T20:24:21.615Z`.
The [submission receipt](../../../../tmp/app-workflow-iphone/build-submit.json)
records app version `0.1.0` and iOS build number `2`; the selected provisioning
profile includes the registered phone. The build reached **FINISHED** at
`2026-09-27T20:29:46.566Z`, with native compilation, signing and upload successful;
the [terminal status](../../../../tmp/app-workflow-iphone/build-status.json) and
downloaded build-log receipts record that result.

The [replacement IPA](https://expo.dev/artifacts/eas/a29UcQ6AOOnSm3RmulhexwLEsA3XpCxCaL8lrjkhEYM.ipa)
was retrieved with HTTP `200`, exactly `16961103` bytes. Its SHA-256 is
`8632ce5ca253617d8d9028c843bfa15e4a2cfdd9a03de6afd2943f1df4be34ce`.
The [IPA inspection](../../../../tmp/app-workflow-iphone/ipa-inspection.json) confirms
bundle identifier `app.locallab.mobile`, version `0.1.0`, build `2`, minimum iOS
`17.0`, and the local-network usage description. The embedded provisioning
profile includes the registered device (`registeredDeviceIncluded: true`, device count
`1`), expires `2027-09-27T16:42:38Z`, and sets `getTaskAllow: false`. Inspection
extracts the signed-profile XML; it does not independently validate the signature
(`signatureChecked: false`). Build success and artifact inspection do not prove
physical installation or app behavior.

Saved build logs show ad hoc configuration and the selected provisioning profile,
followed by **Archive Succeeded** and successful signing/upload. Expo Doctor
passed `18/21` checks, with nonfatal follow-ups: direct `expo-modules-core`
dependency; same-version pnpm peer-context duplicates of `expo`,
`expo-modules-core` and `react-native`; installed React Native Web `0.21.0` where
the SDK expects `^0.21.2`. The finished archive does not make this a clean Doctor
result. These dependency-alignment follow-ups remain recorded without claiming
device runtime proof.

The submission fingerprint hash is
`407432e5e40a04a582b2549c7695245a09f6b114`, fingerprint ID
`01a0e48a-43d3-739b-97dd-1851c481b70f`. Use the build ID and submission fingerprint
to identify this upload. The reported Git commit is only the checkout commit:
uncommitted and untracked app changes are part of the submitted working tree, so
that commit alone does not identify all built source changes.

Current Expo configuration introspection passes with that build number, bundle
identifier `app.locallab.mobile` and the clipboard dependency; its saved result is
[introspected-config.json](../../../../tmp/app-workflow-iphone/introspected-config.json).
This is configuration evidence; the separate finished build supplies native
compilation/signing proof for the current Device import, clipboard dependency
and workflow fixes. Remaining native gates include installation/reinstallation of that
binary, physical safe-area/layout and keyboard interaction, native picker/share
and SecureStore behavior, reachable-LAN chat, foreground/background cancellation,
partial-output reopening, and actual local inference with a licensed managed
model. iOS JavaScript export or native compilation cannot replace those checks.

Source preflight has the following receipts. The final release export includes
both the native bootstrap compatibility fix and the conditional Provider-close
fix. It supersedes the two earlier JavaScript snapshots. These gates are separate
from the browser reports and physical-device validation.

The current repository `format:check` also passed with exit `0` for all matched
source. This audit is formatted separately with Prettier's explicit
`--ignore-path NUL` because the normal ignore rules exclude the documentation.

| Gate                                                     | Current result                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Configured workspace typechecks                          | Earlier all-`53`-project pass; mobile typecheck passed again after native compatibility and the Provider-close fix                                                                                                                                                 |
| Expo configuration introspection                         | Passed; iOS build number `2`, `app.locallab.mobile`; [saved config](../../../../tmp/app-workflow-iphone/introspected-config.json)                                                                                                                                     |
| Pre-compatibility-fix iOS JavaScript/Hermes export       | Passed, exit `0`; [export directory](../../../../tmp/app-workflow-ios-export); `1637` modules, `43` assets; `entry-e1226833fef25c9ace7d99b83001a9e5.hbc`, `5168540` bytes                                                                                             |
| Post-compatibility iOS export, before Provider-close fix | Passed, exit `0`; [export directory](../../../../tmp/app-workflow-ios-export-native-final); `1638` modules, `43` assets; `entry-7b8c67b2fbc8388a5c73bceab6b6a2e0.hbc`, `5169833` bytes                                                                                |
| Final release iOS JavaScript/Hermes export               | Passed, exit `0`; [release export directory](../../../../tmp/app-workflow-ios-export-release-final); `1638` modules, `43` assets; `entry-5ed29fe8108b0130a5e4fbda1a0f05a4.hbc`, exactly `5169923` bytes; includes native compatibility and Provider conditional close |

The final release export includes Clipboard, native Device imports, theme/Memory,
context/source, the aggregate attachment notice, native AbortController
compatibility and the Provider conditional-close fix. The concrete traced
AbortController callers are the avatar picker, which passes a controller, and
Memory extraction, which requires signals. The main composer
intake calls preparation without a signal and bypasses empty references; this
finding is scoped to those signaled avatar/Memory paths. Native bootstrap
compatibility is now published with a web no-op and root installation before
first render. Focused verification passed `2/2` using the actual installed RN
constructor, Expo 57 static-any patch and Expo DOMException. It covers reason
identity/default/null/already-aborted/reabort behavior, admission/rejection without
dispatch, static-any propagation, idempotence and the web no-op. Mobile typecheck
and owned formatting passed. This exercises the JavaScript constructors rather
than a physical app; the earlier phone startup cause remains unresolved. Export does not
compile/sign a new native app, consume a cloud build, or establish device
installation/inference.

A transient web boundary-run failure was also traced to the root layout import
being published before the new compatibility files existed, producing HTTP `500`
on reload. The server log establishes that cause; it is not attributed to slow
readiness or attachment logic. At that repair checkpoint, the files/layout were
stable and the entry bundle returned HTTP `200` (`6370494` JavaScript bytes). The fresh six-case
attachment rerun has passed `6/6`. The final release export also passed after the
subsequent Provider-close fix.

### Physical iPhone validation checklist

Record the exact build ID/submission fingerprint and device/iOS version with every
receipt. Use the finished replacement build `2` for this pending device checklist;
installing the historical build cannot validate these changes.

| User action                                                                                                | Required visible result                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install and launch the current preview                                                                     | Current build opens without Metro; no silent install failure or startup exception                                                                                                            |
| Choose setup mode/theme, enter chat, reopen Get Started and cold-launch                                    | Choices visibly apply immediately and persist; both setup paths reach a usable conversation                                                                                                  |
| Read portrait screens and focus the keyboard                                                               | Status/camera cutout and home indicator do not cover text or controls; composer, source message and Latest remain reachable                                                                  |
| Configure a reachable local-server address, Test connection, save exact `local-coder`, send Python request | The exact provider/model is used; primary fenced code is visible; settings/provider/transcript survive cold-launch                                                                           |
| Start an actual stream, Stop, send again, background during generation, force-close and reopen             | Partial text persists; terminal stopped state is honest; resources drain before the next local run; no permanent Generating state                                                            |
| Pick/cancel/remove files, export/import TXT/PDF/ZIP, copy the app's own fenced reply                       | Original bytes and transcript survive; picker/share cancel is usable; permission/extraction failures have recovery; Copy preserves fences/indentation                                        |
| Edit/select Persona, enable Memory consent and open a sourced fact                                         | Saved conversation is retained; next prompt uses selected identity; source opens the exact saved user message; consent/tombstone rules remain effective                                      |
| Run bounded local GGUF probe with the managed licensed artifact/hash                                       | Physical-device load, actual generated tokens, cancellation/drain and repeat admission are recorded against the build/model identity. Apple ML's current unavailable result remains explicit |

### Installation diagnostic path

For the finished replacement preview build `2`:

1. Open that build's EAS detail page, choose **Install** under Build artifact,
   and open its test-device link/QR on the registered iPhone. Record which build
   was selected and whether an app icon appears. Preview builds run without a
   development server. [Expo installation steps](https://docs.expo.dev/tutorial/eas/internal-distribution-builds/)
2. Confirm the iPhone was included in **that build's** ad hoc provisioning
   profile. Being registered for a later build is insufficient for an older
   artifact. [Expo internal distribution](https://docs.expo.dev/build/internal-distribution/)
3. If iOS requests Developer Mode when opening the installed app, follow
   **Settings → Privacy & Security → Developer Mode**, restart, then complete
   the system confirmation. [Expo Developer Mode guide](https://docs.expo.dev/guides/ios-developer-mode/)

If installation again has no visible error, collect a short screen recording
from opening the install link through the Home Screen result, the exact time,
iPhone model/iOS version, selected build ID, and any exact Safari/iOS alert. Note
whether failure occurs before an icon appears, during installation, or on first
launch. The coordinator can then compare that receipt with the build status,
artifact and included-device metadata through read-only checks. A reachable build
page alone does not establish a successful device install; the earlier reinstall
cause remains unresolved. Account authentication/signing stays in the user's
private terminal flow.

The initial expanded report, frozen-source affected-flow report and final release
export receipts are recorded above. The known Provider navigation failure is
resolved by the source fix and current `4/4` proof. The initial run changed source
after that failure and remains a mixed snapshot, not a clean current-source
`62/62` pass. Scoped results are not combined into an invented full-suite total.

**Browser audit result:** the mounted workflows have the rendered, persistence,
fixture and real local-provider evidence listed here, and the known material
browser failures have fixes with focused proof. OxCoder is configured in the
dedicated local profile. **The user goal is not marked complete:** physical
native installation/layout, lifecycle, native storage/picker/share behavior and
actual device-local inference still require the checklist above. Unmounted
inventory features remain outside this audit's proof.
