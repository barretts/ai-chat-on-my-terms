# Live local app validation — 2026-09-27

## Scope and historical result

This follows the [initial four rendered checks](local-ui-regression-2026-09-27.md). The work exercised the shared Expo app in installed Google Chrome on Windows, including actual requests to the user's running local model. The [local preview guide](../../local-ui-testing.md) gives the launch, provider setup and test commands. The [iPhone installation guide](../../iphone-installation.md) records the earlier signed binary and its separate native limitations.

The final full rerun for this earlier snapshot passed **36/36**, with zero skipped, unexpected or flaky checks and process exit `0`. It includes the transcript scroll fix, both long-history viewport scenarios and the previously failing real phone recovery scenario. The first run and its failure remain recorded below as historical evidence. The [expanded workflow audit](app-workflow-audit-2026-09-27.md) records subsequent source fixes and their verification; this 36-check result does not cover those later changes.

| Final full rerun             | Recorded value                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Report                       | [tmp/full-local-ui-validation-final/report.json](../../../tmp/full-local-ui-validation-final/report.json) |
| Start                        | `2026-09-27T19:13:25.203Z`                                                                                |
| Duration                     | `275.415821` seconds                                                                                      |
| Passed / failed              | `36 / 0`                                                                                                  |
| Skipped / unexpected / flaky | `0 / 0 / 0`                                                                                               |
| Exit                         | `0`                                                                                                       |
| Browser                      | Installed Google Chrome; one worker, no retries                                                           |
| Projects                     | Desktop `1280 × 900`; Chromium with iPhone 13 viewport emulation                                          |

## Historical first full run

The first full run recorded **33/34 passed** before the source scroll fix. Its metrics and failure artifacts are retained independently from the successful final rerun.

| First full run  | Recorded value                                                                                |
| --------------- | --------------------------------------------------------------------------------------------- |
| Report          | [tmp/full-local-ui-validation/report.json](../../../tmp/full-local-ui-validation/report.json) |
| Start           | `2026-09-27T19:02:58.849Z`                                                                    |
| Duration        | `294.739349` seconds                                                                          |
| Passed / failed | `33 / 1`                                                                                      |
| Skipped / flaky | `0 / 0`                                                                                       |
| Browser         | Installed Google Chrome; one worker, no retries                                               |
| Projects        | Desktop `1280 × 900`; Chromium with iPhone 13 viewport emulation                              |

The failed scenario was `generation-recovery.spec.ts`: **reload during a real streamed response preserves partial text and recovers the run**, in the phone project. Partial reasoning survived the first reload, the interrupted run became stopped, and a new real reply completed. After the **second reload**, the saved assistant reply still contained the expected Helix text but was outside the viewport: `toBeInViewport` reported ratio `0`. The [failure context](../../../tmp/full-local-ui-validation/generation-recovery-reload-f2e70-l-text-and-recovers-the-run-phone/error-context.md), screenshot and retained trace remain in that scenario's artifact directory. The desktop version passed in that first run.

## Transcript scroll fix and scoped follow-up

The transcript now uses measured content height and viewport height to schedule the latest offset on the next animation frame, after FlatList layout bookkeeping. Following the latest reply is tracked separately from the current offset. Manual upward scrolling cancels that follow behavior; viewport changes preserve the user's reading position. The **Latest message** button stays available until an observed scroll confirms arrival at the end. Source-message navigation retains its separate focus behavior.

| Completed scoped proof                                                        | Result | Scope                                                                                                                       |
| ----------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Long hydrated history, manual wheel scrolling, viewport resize, Latest action | `2/2`  | Desktop and phone viewport; real archive import and persistent transcript, without generated or intercepted provider output |
| Exact real phone recovery scenario that failed in the first full run          | `1/1`  | Actual local model generation, interrupted-run recovery, new reply and visibility after the second reload                   |

The long-history scenario is [tests/ui/transcript-scroll.spec.ts](../../../tests/ui/transcript-scroll.spec.ts). Its scoped screenshots are under `tmp/transcript-scroll-offline-final-results/`, including [phone latest after manual reading](../../../tmp/transcript-scroll-offline-final-results/transcript-scroll-hydrated-ba129-ding-through-layout-changes-phone/latest-after-manual-reading.png). The scoped real phone rerun artifacts are under `tmp/generation-recovery-scroll-fixed-final-results/`, including [new response after recovery](../../../tmp/generation-recovery-scroll-fixed-final-results/generation-recovery-reload-f2e70-l-text-and-recovers-the-run-phone/new-response-after-recovery.png). The final full rerun then passed both viewport projects for long-history scrolling and all four recovery checks.

## Actual local provider

The session verified the running llama.cpp API at `http://127.0.0.1:35961/v1`, its exact model ID `local-coder`, and the loaded OxCoder server's `n_ctx` of **16384**. That server value is separate from LocalLab's editable context setting. Server metadata and its actual chat template were checked; the local model process was left running with its existing configuration.

The server's CORS response permitted its own origin rather than the preview at `http://localhost:8081`, preventing direct browser chat requests. The local preview now relays only origins explicitly supplied to `tools/start-local-preview.ps1`. The relay streams upstream bytes, propagates client cancellation, forwards configured provider headers, rejects unapproved destinations and upstream redirects, and does not forward browser cookies. `providerFetch.web.ts` preserves the original upstream response URL for the existing redirect checks. Native fetch remains direct; this relay does not make a loopback server reachable from an iPhone.

The OxCoder template recognizes `<|think_off|>`. Initial real requests exposed repetitive thinking that could exhaust the output budget without a final answer. Brief-answer scenarios set that template control through the app's real System prompt field. The compatible adapter preserves reasoning deltas and the server's finish reason; output-budget exhaustion has a separate UI status. The flag is specific to this loaded template, not a general provider instruction.

### Configured persistent preview profile

The dedicated browser profile was configured with `local-coder`, a LocalLab context window of `16384`, maximum output tokens of `2048`, and this saved model System prompt:

```text
<|think_off|>
You are a helpful coding assistant. Give clear, concise answers and working code when asked.
```

The actual request went to `http://127.0.0.1:35961/v1/chat/completions` with that exact model, system instruction and `max_tokens: 2048`. The request asked for a Python `add(a, b)` function, and the visible completed reply contained:

```python
def add(a, b):
    return a + b
```

Reload retained the provider, saved settings and this transcript in the configured profile. Evidence is [configured-real-chat.png](../../../tmp/configured-local-preview/configured-real-chat.png) and [requests.json](../../../tmp/configured-local-preview/requests.json). This profile proof is separate from the isolated test contexts and does not count as another full-suite result.

At handoff, the dedicated Chrome app window was launched as process `24812` with `tmp/locallab-preview-profile/` and `--app=http://localhost:8081`. A read-only preview launcher check confirmed reuse of this workspace's server process `7248` on port `8081`; these are session process IDs, not fixed launch settings.

## Rendered coverage in the final full rerun

The scenarios click rendered controls, type into forms, reload the app, choose real browser files and inspect downloaded bytes. Live-model rows below contact the existing local server. Fixture rows intercept HTTP responses and do not contact paid providers.

| Scenarios                       | Result  | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding and themes           | `4/4`   | Visible dark/light and beginner/power choices, saved choices after reload, navigation into chat, toolbar expansion and an intercepted HTTPS provider reply saved through the real adapter/engine                                                                                                                                                                                                                            |
| Connections, Models and Library | `8/8`   | Save/edit/delete/reorder without duplicate connections; header replacement and browser key re-entry; exact server/model choices restored after reload; linked connection edits change the chat destination, deletion clears the selection; folder create/move/rename/color/delete with inline confirmation; ordinary saved-message search and reopening its source; fixture Ollama pull cancellation and confirmed deletion |
| Attachments and archives        | `4/4`   | Actual text file bytes included in a real local request; the reply identified the note's flower; ZIP export/import/reopen preserves originals and descriptors; TXT/PDF downloads; malformed JSON/ZIP rejection; invalid UTF-8 and unavailable PDF extraction retain the original with a working Remove action                                                                                                               |
| Real chat                       | `2/2`   | Explicit HTTP authorization, actual model inventory test, exact `local-coder` request binding, persisted context/output settings, streamed reply, Stop, retry without another user row, reload and new chat retaining the provider                                                                                                                                                                                          |
| Persona, Memory and Settings    | `12/12` | Profile CRUD/selection/launch, avatar file intake/reload/removal, manual fact CRUD/search, consent persistence, settings scope/reset/number typing, and two real sourced-memory/Persona scenarios described below                                                                                                                                                                                                           |
| Generation recovery             | `4/4`   | Both viewport projects preserve partial output through reload, complete a new real reply with visibility after the second reload, preserve another live tab's owner and recover after it closes                                                                                                                                                                                                                             |
| Transcript scrolling            | `2/2`   | Long imported history starts and reopens at the latest answer; manual upward reading survives a viewport resize; Latest returns to the visible final reply in both projects                                                                                                                                                                                                                                                 |

The durable browser paths use Expo SQLite's WebAssembly/OPFS database and IndexedDB managed blob bytes, not an in-memory persistence substitute. The OPFS implementation currently allows one open LocalLab tab per browser profile. A second tab shows an actionable storage-busy message, leaves the first tab's generation ownership intact, and retries after that tab closes. Web retry reloads the page to obtain a fresh SQLite worker rather than reusing the worker left after the failed open. Both viewport projects passed that scenario.

## Fixes exercised during this validation

- **Platform identities and ordering:** mobile composition supplies the platform UUID port to chat run/message allocation and related stores. Native randomness uses the Expo SDK crypto adapter; browser execution uses Web Crypto. Durable message sequence allocation preserves transcript order when user and assistant timestamps coincide, including regeneration. Native execution itself is not established by browser checks.
- **Settings and controls:** writes are serialized and the next send waits for pending durable settings edits. Model settings match the selected exact model; provider/model binding controls in Settings point users to the actual provider workflow. Number inputs allow partial typing and commit valid values. Relevant scrolling forms use `keyboardShouldPersistTaps="handled"`. Inline confirmations make folder/model deletion reviewable in the browser, and unavailable operations have explanations.
- **Search visibility:** conversation search reads the selected response variant and ordinary user/assistant text. Package fixtures reject stale, hidden, reasoning and tool text; the rendered Library scenario verifies ordinary search and source navigation. Semantic search stays unavailable without an embedding engine.
- **Cloud credentials:** the same helper used by Provider setup Save and Test stores Anthropic `x-api-key`, Gemini `x-goog-api-key`, and the authorization shapes expected by other adapters. OpenAI normalizes older Bearer prefixes; Anthropic can repair the previous host-bound generic authorization ref. Fixture requests verify actual outbound headers and host mismatch rejection. Gemini/Mistral inventory no longer inserts an entered but unverified model ID, so Test rejects catalog misses. No live cloud account or paid provider request is claimed.
- **Recovery and ownership:** app sessions tag persisted runs with generation ownership. Recovery claims only dead, known app owners, preserves partial output and binding, and records cancellation without resending. Unknown/live owners are not inferred to be abandoned. Foreground admission checks, background cancellation and scoped SQLite transactions have focused regression coverage; the real browser reload and two-tab paths provide the narrower live evidence above.

### Real Memory and Persona proof

Both desktop and phone scenarios passed `Real local replies preserve Persona history and extract sourced memory after consent` against `local-coder`.

The UI enabled injection and extraction explicitly, added a manual global fact and sent a preference about the Helix editor. Captured real requests verify the selected model, output limit and injected fact. The background extraction request kept only the model template control before its separate extraction/JSON instructions, used `max_output_tokens: 2048`, and did not inherit the chat's one-sentence instruction. The model produced a saved fact with an exact user source quote; **Open source message** returned to that original user message.

After disabling extraction, switching to a custom Persona preserved the conversation and changed the next request's Persona/settings prompts. The prior global manual fact was absent from that Persona's injected prompt, the original user message remained in conversation history, and there was no second extraction request. Reload retained the selected Persona and both replies. This proves this consented local example, not general extraction accuracy across models.

Focused Memory checks additionally cover deleted-fact prompt exclusion, original-user grounding, cancellation, pending `next()`/`return()` resource drainage and transaction isolation. Durable cancellation does not release a busy provider before actual cleanup; the admission gate remains held. Large legacy Memory pagination was not exercised in the browser session.

## Focused verification

These are the session's focused check groups. They are not added to the rendered-check count or combined into a grand total; composition/provider tests and rendered scenarios can exercise overlapping behavior.

| Check group                                  | Passing checks                                            |
| -------------------------------------------- | --------------------------------------------------------- |
| Mobile composition, settings and transcript  | `58`                                                      |
| Memory extraction/store/coordinator          | `20`                                                      |
| Chat engine core / advanced                  | `6 / 3`                                                   |
| Compatible local provider / chat integration | `7 / 10`                                                  |
| Cloud adapters                               | `20` — OpenAI `6`, Anthropic `4`, Gemini `5`, Mistral `5` |
| Models / conversation Library                | `5 / 3`                                                   |
| Local preview relay                          | `1`                                                       |

Mobile and the changed provider package typechecks and owned-file formatting passed. Existing focused platform crypto tests use labeled native SDK fixtures.

The latest iOS JavaScript/Hermes export also passed: **1630 modules**, **43 assets**, and the **5.1 MB** bundle `entry-5ddbd81db55de7697aa5d84336420867.hbc` under `tmp/local-preview-ios-export-final/`. Its [metadata](../../../tmp/local-preview-ios-export-final/metadata.json) records the bundle and 43 assets; the [Hermes artifact](../../../tmp/local-preview-ios-export-final/_expo/static/js/ios/entry-5ddbd81db55de7697aa5d84336420867.hbc) is `5,130,163` bytes. Export success does not establish physical iOS screen behavior, native inference or installation.

Final artifacts are under ignored `tmp/full-local-ui-validation-final/`; the first run remains under `tmp/full-local-ui-validation/`. Useful generated screenshots include `live-response.png`, `models-selection-durable.png`, `library-durable.png`, `attachment-live-response.png`, `archive-reopened.png`, `live-extracted-memory-with-source.png`, `second-tab-recovered-after-retry.png` and `latest-after-manual-reading.png`. The final [phone real reply](../../../tmp/full-local-ui-validation-final/live-chat-real-local-serve-bae8f-ly-stop-reload-and-new-chat-phone/live-response.png), [phone reply after recovery](../../../tmp/full-local-ui-validation-final/generation-recovery-reload-f2e70-l-text-and-recovers-the-run-phone/new-response-after-recovery.png) and [phone sourced Memory](../../../tmp/full-local-ui-validation-final/supporting-panels-Real-loc-03be0-ourced-memory-after-consent-phone/live-extracted-memory-with-source.png) were also visually reviewed in the session: primary text, the saved fact and its source controls were legible. The JSON report embeds the live chat/settings/memory request attachments. Test sources are under `tests/ui/`; relay regression coverage is `tests/local-preview/proxy.test.cjs`.

## Still unproven

- Phone viewport emulation is Chromium, not Safari, a simulator or an iPhone. Physical safe-area, keyboard, camera, background transitions and native resource release remain pending.
- Native GGUF inference/import/download, Apple MLX/Core ML inference, iPhone LAN access and the silent ad hoc reinstall failure are not established here. The first IPA contains earlier code; no new cloud build was submitted during this local validation. Apple inference still has the previously documented engine linkage limitation.
- Group chat, web search, semantic search without an embedding engine, unavailable local model import/download and PDF/XLSX text extraction are explicitly unavailable. Their disabled controls or retained-original explanations do not establish those features as implemented.
- Provider keys in the browser last for the current tab; native SecureStore behavior has fixture/source coverage but no new physical-device credential test. Large legacy Memory pagination and broad live-model extraction quality remain unproven.
