# Offline neural speech

`mobileSpeech` is the shared speech service. The browser runs sherpa-onnx in a dedicated worker; iOS uses the native Sherpa module and Expo Audio for playback. No text is sent to a speech endpoint.

## Voices and sources

- Kokoro 82M v1.0: Heart (`af_heart`, speaker 3) and Bella (`af_bella`, speaker 2). The [author's voice card](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) identifies both as American English female voices. [Sherpa's v1.0 speaker map](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html) supplies the exact IDs. Model: Apache 2.0.
- Piper LJ Speech high: Linda, speaker 0. Its [specific model card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/high/MODEL_CARD) identifies a US English female voice trained from scratch using the public-domain [LJ Speech dataset](https://keithito.com/LJ-Speech-Dataset/). Lessac is excluded because its dataset licence is restricted.

Native integration is pinned to `@siteed/sherpa-onnx.rn@1.3.2-beta.0`, matching Expo SDK57. That published tarball omits its advertised WASM files. Browser assets are therefore explicitly taken from `@siteed/sherpa-onnx.rn@1.3.1`, whose runtime also targets sherpa-onnx 1.13.0. The package's browser convenience adapter has an incomplete Kokoro configuration; the owned worker uses the shipped C-API binding with all model, voice, pronunciation and lexicon files.

## Prepare this preview host

From the repository root, run `powershell -NoProfile -File tools/prepare-offline-speech.ps1`. It downloads public model archives and the pinned WASM runtime, extracts local assets, preserves model licence/card files, and creates SHA256 manifests under `apps/mobile/public/speech`. Browser **Download model** installs those bytes into persistent CacheStorage. Reading aloud subsequently loads only those cached bytes, including its worker and WASM runtime; no inference server or internet access is required.

iOS downloads official archives directly into app storage. The catalogue pins each archive's exact bytes and SHA256, checked incrementally before extraction. A versioned completion marker is written only after required files exist. An app build containing the new native modules is required; Expo Go and older installed builds cannot provide this runtime.

## Resources and cancellation

Only one speech operation runs at a time. Browser Stop aborts downloads, terminates inference and stops Web Audio playback. Cached bytes are rechecked before each load. Native Stop suppresses stale generated audio and waits for native inference/extraction to drain before admitting another operation. Native synthesis uses `playAudio: false`; only the owned Expo Audio player starts playback after the cancellation token is checked. Player status supplies the actual playback/finish state. The pinned native patch removes the upstream full spoken-text log.

Input is bounded to 3,000 characters. Closing the speech panel stops its operation. Downloads and selected voice persist independently of chat history. Native device playback, download interruption and physical iPhone behavior require a new build and device exercise; a Windows browser exercise does not establish those results.
