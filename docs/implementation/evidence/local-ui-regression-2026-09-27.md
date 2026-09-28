# Local UI regression check — 2026-09-27

## Trigger

The user exercised the first signed iPhone preview and reported inactive theme/setup choices, text beneath the camera cutout, failure to reach chat, and a silent reinstall failure after deleting the app. Compilation had succeeded, but screen interaction had not been verified before distribution.

## Changes

- Shared Expo routes now run locally through React Native Web. Added the SDK-matched React DOM, web renderer, and Metro runtime dependencies, plus Playwright 1.63.0.
- A root Paper theme provider applies preferences immediately and saves them through SQLite. Setup choices have visible selection and screen reader feedback. Chat, settings, composer, and transcript colors follow the selected theme.
- Beginner setup opens a smaller toolbar with an explicit More tools control; Power user exposes the full toolbar.
- SafeAreaProvider and SafeAreaView wrap the root navigator. Physical camera-cutout verification remains pending.
- All production routes share one app-lifetime database opener. Route cleanup no longer closes the shared native database. Startup failures have recovery actions.
- Native UUID/random/hash operations use SDK-matched ExpoCrypto through explicit ports. Secret references, connection/provider IDs, managed blobs, archives, and chat allocation receive platform crypto. Browser implementations use Web Crypto.
- Browser blob storage uses IndexedDB; browser keys stay in tab memory. Native inference is explicitly unavailable in the browser. Unimplemented suggested downloads are disabled with a working continue action.

## Executed checks

`pnpm test:mobile-ui` passed **4/4** rendered checks in installed Google Chrome: two scenarios at desktop size and two at a phone viewport. Final run started 2026-09-27 17:31:56 UTC and completed in 33.9 seconds with no failures or flaky tests.

The scenarios clicked actual controls and verified live dark/light backgrounds, selected mode, saved choices after reload, setup-to-chat navigation, returning through Models/Setup, persisted settings changes, beginner toolbar expansion, endpoint form entry, sending through the real provider adapter and AdvancedChatEngine, transcript rendering, and persisted messages after reloading and reopening the conversation. The HTTPS response was intercepted by Playwright; it did not contact a real paid provider. Page errors and initial chat errors were checked. Narrow viewport horizontal overflow was checked.

Screenshots were visually inspected after the final palette changes. They show readable dark composer/transcript colors and selected controls. The initial rendered check exposed Paper Button dropping selected accessibility state from its inner touch control; selection is now conveyed by the actual control's accessible label.

- Mobile TypeScript check: pass.
- Focused composer/transcript/Markdown fixtures: 9/9 pass.
- Focused crypto checks: 4/4 pass; native SDK calls use a labeled fixture, not a physical device.
- Secret store checks: 3/3 pass, including explicit randomness with the browser crypto global absent.
- Updated iOS JavaScript/Hermes export: pass, 1,621 modules and 43 assets, 5.1 MB bundle in `tmp/local-preview-ios-export`.
- New/changed files' formatting: pass.
- Local preview: HTTP 200 at `http://localhost:8081`, background helper process 15420; logs under `tmp/local-preview/`.

Test report and screenshots are under ignored `tmp/mobile-ui-results/`. Preview startup instructions are in `docs/local-ui-testing.md`.

## Limits

This establishes shared UI behavior and the tested browser database paths. It does not establish physical iOS safe-area/keyboard behavior, native crypto execution, GGUF/Apple model inference, or ad hoc reinstall behavior. The first IPA remains reachable with HTTP 200 and has not been replaced by these fixes. The silent reinstall failure is unresolved. The next native build and phone retest remain pending; no new cloud build was submitted in this local testing pass.

## Follow-up local validation

The later [live local app validation](live-local-app-validation-2026-09-27.md) records the running OxCoder server, broader rendered coverage, durable files/archives, privacy, provider setup and recovery checks. Its first full run passed 33/34; the phone viewport failure after a second reload was fixed, and the final expanded run passed 36/36. The four checks and metrics above remain the historical initial result.
