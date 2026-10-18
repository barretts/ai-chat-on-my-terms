# Phone models, speech, and OpenRouter — September 27, 2026

The user requested model, TTS, and OpenRouter options, with each feature exercised in the app before automated testing. All three actual app walkthroughs completed before checks began. The last walkthrough, reading a real assistant reply offline from chat, completed at **2026-09-28 04:33:21.930 UTC**. Targeted checks started afterward, at **04:33:59 UTC**. September 27 is the local America/Chicago date.

## OpenRouter: actual app exercise complete

An isolated Chrome context at 440 × 956 opened the real app at `http://localhost:8083`. The clean walkthrough ran **2026-09-28 03:56:15.812–03:56:35.239 UTC**, September 27 in America/Chicago. Upstream responses were genuine; no model-response fixture, user API key, account access, or chat request was used.

| App action                            | Observed result                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose OpenRouter                     | Provider name populated; official `https://openrouter.ai/api/v1` endpoint populated and locked.                                                                                                       |
| Save or test without a key            | Visible “Enter your OpenRouter API key.” error.                                                                                                                                                       |
| Load public catalog                   | Real `GET /api/v1/models` returned **HTTP 200**; **458** models appeared.                                                                                                                             |
| Search and select                     | Searching Qwen selected the actual catalog ID `qwen/qwen-2.5-72b-instruct`; exact ID populated the model field. This was an exercise choice, not a phone model recommendation.                        |
| Check an explicitly invalid dummy key | Real `GET /api/v1/key` returned **HTTP 401**; the app displayed an actionable rejection without echoing the supplied key.                                                                             |
| Save and reload local configuration   | The provider/model selection persisted, its saved provider remained selectable, and the API-key input was empty. The saved dummy key was invalid; this does not establish a working cloud connection. |

The walkthrough recorded **zero chat POSTs** and **zero page errors**. Paid chat, successful authentication with a real key, native key storage, physical iPhone installation, and physical iPhone operation are **unverified**.

### Local receipts

These artifacts are in ignored `tmp/` directories:

- [Clean walkthrough steps and HTTP statuses](../../../../tmp/openrouter-manual-complete/walkthrough.json).
- [Public catalog and model choices](../../../../tmp/openrouter-manual-complete/public-catalog-model-options.png).
- [Genuine invalid-key rejection](../../../../tmp/openrouter-manual-complete/real-invalid-key-rejection.png).
- [Saved provider selection after reload](../../../../tmp/openrouter-manual-complete/saved-provider-selection.png).
- [Imperative app walkthrough driver](../../../../tmp/openrouter-manual/exercise.cjs). No Playwright test runner or response mocks were used.

The earlier attempt at **2026-09-28 03:47:43 UTC** reached catalog loading, key rejection, and local save, then encountered a blank reload while a shared model-download import was pending. Its [steps/statuses](../../../../tmp/openrouter-manual/walkthrough.json) and [interrupted screenshot](../../../../tmp/openrouter-manual/walkthrough-interrupted.png) are preserved. The clean stable-bundle walkthrough above supplies the completed reload receipt.

### Source and API contract

- [Provider setup UI](../../../../apps/mobile/composition/chat/provider-setup.tsx): preset, public catalog/search/selection, required-key save, and key check before model verification.
- [Credential helper](../../../../apps/mobile/composition/chat/provider-setup-helpers.ts): the current-key request uses the existing HTTP transport and host-scoped SecretStore, with redacted failures.
- [Existing cloud-compatible adapter](../../../../packages/providers/cloud/compatible/src/index.ts): only OpenRouter public model discovery permits an absent credential. Generation and other provider discovery still require one.
- Official OpenRouter contracts: [Bearer authentication and API base](https://openrouter.ai/docs/api_reference/authentication), [model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), and [current-key validation](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key).

Focused provider UI and unit fixtures ran only after the final speech walkthrough; results are recorded below.

## Phone models: actual app exercise complete

The actual app at `http://localhost:8083/models` presented the pinned Qwen3.5 0.8B, 2B, and 4B Q4_K_M options. The isolated Chrome walkthrough ran **2026-09-28 03:59:31.250–04:00:34.490 UTC**.

- A real download was cancelled through the UI. No partial model became installed.
- The real **532,517,120-byte** 0.8B file was downloaded from its pinned Hugging Face revision, then verified against its exact SHA-256 and GGUF signature, including the bytes persisted in OPFS.
- **Use in chat** saved the named offline model. The download and named chat-provider selection survived reload.
- **Keep download** preserved the file after opening the removal confirmation.
- A later confirmed **Remove** action at **04:04:00.358 UTC** removed the file and cleared its chat selection. The private managed-file directory was empty, and chat showed **Offline model required**. Saved conversation storage remained available.

[Walkthrough steps](../../../../tmp/models-manual/walkthrough.json), [model options](../../../../tmp/models-manual/phone-options.png), [verified download after reload](../../../../tmp/models-manual/verified-model-reopened.png), [selected named provider](../../../../tmp/models-manual/selected-phone-provider.png), [removal receipt](../../../../tmp/models-manual/removal.json), and [chat after removal](../../../../tmp/models-manual/removed-model-chat.png) record these actions. No model-response fixture or test runner was used.

### Real local generation from the same artifact

The verified file downloaded through the app was copied in bounded chunks to a workspace file and independently matched SHA-256 `bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517`. A separate Windows llama.cpp instance loaded it with a 4K context and four CPU threads. In the actual app at `http://localhost:8084`, a compatible-provider connection listed the model and generated a real response. The reply survived app reload at **04:05:57.053 UTC**.

The app observed real **GET `/v1/models` HTTP 200** and **POST `/v1/chat/completions` HTTP 200**, with zero page errors. [Generation receipt](../../../../tmp/models-manual/pc-generation.json), [saved reply screenshot](../../../../tmp/models-manual/actual-model-pc-response.png), and [runtime log](../../../../tmp/models-manual/server-error.log) supply the evidence.

This establishes Windows generation for the selected 0.8B artifact. It does not establish native llama.rn execution, physical iPhone performance, or actual generation from the larger 2B/4B artifacts. Those two options have verified publisher metadata and hashes; their complete weights were not downloaded in this walkthrough.

## TTS: actual app exercise complete

Both real speech models were downloaded, verified, and retained in the isolated browser profile through ordinary app controls. The browser **Check download** action reconciled the updated runtime and reverified saved model files. The browser network was then disabled before each synthesis request. No speech service or inference-response fixture was used.

| Voice        | Actual generated WAV         | Sample rate | Playback result                |
| ------------ | ---------------------------- | ----------- | ------------------------------ |
| Kokoro Heart | 280,808 bytes; 5.849 seconds | 24,000 Hz   | Finished reading aloud offline |
| Kokoro Bella | 279,348 bytes; 5.819 seconds | 24,000 Hz   | Finished reading aloud offline |
| Piper Linda  | 298,540 bytes; 6.769 seconds | 22,050 Hz   | Finished reading aloud offline |

All three WAVs had nonzero signal energy and distinct hashes. The [audio observations](../../../../tmp/offline-speech-manual/manual-audio-observations.json) at **04:30:44.815 UTC** record PCM measurements, exact hashes, the actual completion messages, and zero page errors. This proves generation and browser playback completion. The headless browser muted its physical output; human listening and physical iPhone output are unverified.

The [Stop and restart receipt](../../../../tmp/offline-speech-manual/manual-stop-observations.json), **04:32:32.634 UTC**, records both saved downloads and **Selected: Linda** after a full browser restart. Oversized text produced the visible 3,000-character message. Stop during generation left zero generated WAVs, reading afterward completed, and Stop during playback remained stopped after observation. All these speech actions ran with network disabled.

Finally, the app obtained a real short assistant reply from the same downloaded Qwen artifact running on the Windows host. Tapping **Read response aloud** in chat, after disabling network, produced a **94,252-byte** Linda WAV. Actual WebAudio start/end observations show **2.136 seconds** of audio completing after approximately **2.142 seconds**. The [chat speech receipt](../../../../tmp/offline-speech-manual/manual-chat-read-observations.json), **04:33:21.930 UTC**, records genuine local model HTTP 200 responses, zero page errors and zero failed resources.

Local samples: [Heart](../../../../tmp/offline-speech-manual/af_heart.wav), [Bella](../../../../tmp/offline-speech-manual/af_bella.wav), [Linda](../../../../tmp/offline-speech-manual/lj.wav), and [actual assistant reply](../../../../tmp/offline-speech-manual/chat-response-linda-offline.wav). Screenshots include [persisted selection](../../../../tmp/offline-speech-manual/restarted-persisted-models-voice.png), [stopped playback](../../../../tmp/offline-speech-manual/linda-playback-stopped.png), and [chat after reading](../../../../tmp/offline-speech-manual/chat-response-read-offline.png).

### Failures found through actual use

The first attempts exposed Windows ZIP entry separators, an offline WASM URL/fetch path, and the package's incomplete JavaScript C-API struct layout. They were corrected before the successful audio runs. The pinned binary includes Supertonic; the shipped convenience binding omitted its 28-byte configuration and shifted the subsequent rule fields. The owned worker now uses the complete [Sherpa 1.13.0 C API layout](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.0/sherpa-onnx/c-api/c-api.h), zero-initializes unused families, transfers verified cached WASM bytes directly for instantiation, and frees configuration and generated-audio allocations.

Earlier helper interruptions occurred while waiting for asynchronous saved-download refresh or an unneeded page load event. Their observations do not establish a product failure. The successful final run waited for the actual persisted controls and completed page resource loading before disconnecting network. An earlier run recorded a SQLite-worker import error when network was disabled too early; the final chat walkthrough had no such error. The initial [failure screenshot](../../../../tmp/offline-speech-manual/manual-block.png) remains available.

Native adapters and exact archive verification are implemented. Their physical iPhone inference, audio session, cancellation drain, background handling, thermal behavior, and performance remain unverified. The previous signed build 2 does not contain the new native speech module; no new signed build was submitted during this feature pass.

### Development asset delivery

The preview's initial speech downloads were slow. A bounded diagnostic fetched the same real 8 MiB ONNX range through Metro and isolated HTTP streams. Metro took **15.565 seconds**; isolated IPv4/IPv6 delivery took **0.038–0.158 seconds**. All responses were HTTP 206 with identical SHA-256 and no content encoding. A Metro CPU sample consumed roughly one core; the cause remains unproven. Chunk size, IPv6 alone, and repository `tmp/` watching were not established causes. No speculative serving change was applied. The [diagnostic receipt](../../../../tmp/offline-speech-delivery/diagnostic.json) preserves timings and the effective configuration. Isolated diagnostic servers were closed; the app preview remained running.

## Automated checks

All checks below started after the actual model, OpenRouter, and speech walkthroughs completed.

- **29 targeted unit/functional cases passed:** 9 GGUF admission/parameters/lease cases, 5 real SQLite and filesystem storage cases, 2 credential helper cases, 2 catalog cases, 4 fit/onboarding cases, and 7 cloud-compatible provider cases.
- Typechecks passed for mobile, GGUF, catalog, and cloud-compatible provider packages. The initial mobile check found two missing surface accessibility labels and a transferable typed-array annotation; all three were corrected, then mobile typecheck passed.
- Local iOS JavaScript/Hermes export passed: **1,708 modules**, **5.6 MB** bundle, output [metadata](../../../../tmp/phone-models-speech-ios/metadata.json). This establishes the native JavaScript dependency graph, with an upstream Noble exports fallback warning. Swift compilation, signing, installation, and physical operation are separate gates.
- OpenRouter phone UI fixture checks passed **3/3**, zero skipped/unexpected/flaky checks, errors `[]`, exit 0. The [final report](../../../../tmp/feature-options-ui-final/report.json) started **04:37:58.168 UTC** and ran **65.956 seconds**. It covers exact catalog selection, fixture-authenticated streamed generation and reload, actionable errors, and clearing the key when leaving the preset. The initial run passed 2/3; the first case's cold page load consumed approximately 80 seconds of its 90-second budget, leaving insufficient time for reload. The [initial report](../../../../tmp/feature-options-ui/report.json) and trace are preserved. Navigation now waits for DOM readiness, followed by explicit rendered app assertions.
