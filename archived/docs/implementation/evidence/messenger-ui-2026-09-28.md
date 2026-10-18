# Messenger UI and workflow evidence — September 28, 2026

## Scope

This pass implements the requested Windows 98 / Yahoo Messenger style, saved provider list, endpoint-backed model dropdown, download completion fixes, animations, and additional voice features. It exercises the real shared app in isolated task-owned browser profiles. It does not claim a native iPhone run or award recognition.

## Implemented

- Purple title bar, yellow application icon, teal desktop, square/beveled buttons and surfaces, taskbar and status footer; corresponding dark palette.
- Durable Light/Dark/System selection. Fade-in and activity animations respect reduced motion. Modal pickers and the root layout include iOS keyboard avoidance; the root retains its safe-area wrapper.
- Compact chat navigation and a separate writing options dialog, square message bubbles, expandable model reasoning, and taskbar navigation that reuses existing destinations. Short screens suppress extra branding and starter chips; native keyboard events reduce chrome, hide the chat header/taskbar while composing, and expose Hide keyboard in the title bar.
- Saved provider address book: create, edit without duplicating, favorite/order, search, select, remove confirmation and active-provider removal protection. Credentials remain opaque secure-store references; changing endpoint origin does not retain old host credentials.
- Searchable model dropdown queries the real configured endpoint; OpenRouter public discovery needs no key; custom model ID remains available. OpenRouter key verification remains separate from public discovery.
- Offline voice dropdown, persisted studio speed, Persona-specific voice and speed or inheritance. This covers the local bindings in PE-07 and VO-13, the speed portion of PE-08 and VO-05. Cloud voices, participant/group bindings and pitch are still pending.
- Native foreground download sessions, storage checks, distinct saving/unpacking stages and cancellation. Full model/archive SHA scans are skipped; byte counts and GGUF header checks remain. Catalog digests are publisher identity metadata, not locally measured hashes.
- Browser speech runtime repair and revision migration. The new speed-aware worker replaces an older cached worker while preserving voice weights. Preparation scripts also skip large-model hashes by default; optional `-VerifyModelHashes` exists for an explicit future integrity audit.

## Actual app exercises

| Workflow | Evidence |
| --- | --- |
| Phone-sized app, endpoint discovery, provider create/edit/favorite/delete, selected provider reload | `tmp/messenger-redesign/walkthrough.json`: 8 completed steps, zero page errors. Real LAN `/models` returned `local-coder`. |
| Genuine public OpenRouter search | Same walkthrough, `phone-openrouter-picker.png`; no paid generation requested. |
| Real OxCoder reply | `phone-reply.png`, `desktop-reply-polished.png`: real stored response `Ready.` after selecting the saved exact connection. The first follow-up continued through Persona persistence before a script incorrectly attempted to close an automatically closed panel. |
| Persona voice/speed persistence and reset to inherited speed | `followup.json`: successful resumed pass; Bella retained, speed reset, Persona selected. Earlier script stops were disabled/already-closed controls or a transient duplicate locator during modal/route transitions; they were inspected and corrected. |
| Navigation, persisted selected conversation/provider/Persona, dark/light colors, desktop layout | Successful resumed `followup.json`, zero page errors. `phone-dark-polished.png`, `desktop-provider-buddies-polished.png`. |
| Runtime repair without model downloads | `voice-speed.json`: only local speech route, runtime manifest and worker requests; no `/speech/models/` requests. |
| Real offline voice synthesis and changed speed | Same receipt and `offline-Heart-1.wav`, `offline-Heart-1.3.wav`, `offline-Bella-1.3.wav`, `offline-Linda-1.wav`, `offline-Linda-1.3.wav`. Network disabled during all five generations; nonzero PCM energy; zero page errors. |

For the same short passage, Heart duration changed from 3.387s to 2.812s at 1.3×; Linda from 3.843s to 3.309s. Bella at 1.3× generated 2.795s of real audio. Worker request observation confirmed the chosen speed and speaker IDs; inference and playback were not replaced.

No large chat model was downloaded or rehashed during this pass. Existing task-owned browser voice caches were reused without model hashes or redownloads.

## Targeted gates

- Mobile TypeScript check passed after the browser voice runtime changes.
- 22 tests passed across `providers.test.mts`, `provider-setup-helpers.test.mts` and `model-storage.test.mts`. New SQL coverage includes favorite order after reopen/edit and transactional removal protection while preserving conversations. Storage fixtures are eight bytes, not real model weights.
- Three OpenRouter phone viewport fixture cases passed: key authentication/model selection/saved streamed reply, missing-key/authentication/unlisted/empty-list errors, and clearing keys when leaving the preset. Real account generation and billing were not exercised. Receipt: `tmp/messenger-redesign/openrouter-ui/report.json`.
- A local iOS JavaScript/Hermes export passed (1,712 modules after compact layout and keyboard handling). This checks bundling and native module imports; it does not prove native compilation, camera layout, audio output or download behavior on a device.
- The Mac helper passed Bash syntax checking on Windows. It has not run on the user's Mac.

## Short-screen and first-run follow-up

The actual first-run walkthrough found that the 320×568 layout placed Send behind the taskbar. Compact chrome fixed the default layout; opening inline writing controls exposed the overlap again. Moving the controls into a separate dialog fixed that case too.

The final `tmp/messenger-redesign/first-run.json` records 320×568, 390×844 and 440×956 geometry with Send above the taskbar, taskbar inside the viewport, zero horizontal overflow, zero runtime errors, and zero model requests. At 320×568, Send occupies y=451–495 and the taskbar buttons y=518–562. The dialog's Done control fits the viewport. First-run Dark/Power and Light/Beginner choices persisted after reload; Continue without a model opened chat. Compact composer, starter toggle and Return preference persisted; Enter inserted a real newline.

The two updated first-run phone UI regression cases passed, including a durable labeled fixture reply. Receipt: `tmp/messenger-redesign/onboarding-ui/report.json`. Rendered screenshots: `first-run-320.png` and `first-run-320-options.png`; the latter was captured after the opening animation settled. Native keyboard behavior remains a physical-device gate.

## Remaining native verification

Signed iPhone build 3 predates this update. The redesigned source needs a new development/native build. Run the [Mac helper and device guide](../../../../docs/iphone-local-debugging.md) to inspect physical iPhone layout, keyboard, model/voice installation completion, native synthesis and native inference. The locked-down Mac requires the user to run it physically; this Windows session cannot operate it remotely.

Large roadmap items remain explicitly tracked in [feature status](../../feature-status-2026-09-27.md). This pass does not claim dictation, continuous voice, groups, tools/search, generated media, sync, or full roadmap parity.
