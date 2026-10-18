# Phone models, offline voices, and OpenRouter

## Open the local app

The current preview is at **http://localhost:8085**. For a fresh preview, run:

```powershell
& ./tools/prepare-offline-speech.ps1
& ./tools/start-local-preview.ps1 -Port 8085 -ProviderOrigin 'https://openrouter.ai'
```

Open the returned URL. Models, Voices, and Connections are available from the phone chat menu (the desktop calls Connections "Providers"). If you also connect a local model server, include its exact origin in `-ProviderOrigin`, for example `@('https://openrouter.ai', 'http://192.168.1.213:35961')`. The server must already be running.

For this Windows PC, open **Connections** and choose **This PC**. This fills **http://192.168.1.213:35961/v1**, the connection name, and authorization for this local HTTP origin. **Connection settings** exposes the saved address when you need to change it. Open **Chat model** or **Load models** to discover the currently loaded model, then choose **Save & chat**. The endpoint last checked listed **qwen3.8-27b-sm89**; the preset discovers the model instead of hardcoding that ID. On your iPhone, use this LAN address and the same private network as the PC. Local compatible-server generation can run for up to five minutes before its transport timeout. On desktop, the preset is under **Providers → Provider type → Barrett's PC · local coder**.

## Phone models

Open **Models** from chat. The phone downloads are exact Qwen3.5 GGUF artifacts from Unsloth, pinned to a repository revision, file size, and SHA-256 digest.

| Choice                    | Model               | Download |
| ------------------------- | ------------------- | -------- |
| Faster                    | Qwen3.5 0.8B Q4_K_M | 532.5 MB |
| Suggested starting choice | Qwen3.5 2B Q4_K_M   | 1.28 GB  |
| Larger                    | Qwen3.5 4B Q4_K_M   | 2.74 GB  |

For iPhone 17 Pro Max, start with 2B and a 4K context. Try 0.8B for smaller downloads, or 4B if you want to compare more demanding replies. These are recommendations to try; physical iPhone speed and memory fit have not been measured. These downloads support text chat. Vision requires separate projection artifacts that are not included here.

Keep Models open during a download. You can cancel it. The expected size and a small GGUF header are checked before saving. Full model SHA-256 scans are skipped, as requested; catalog digests identify the publisher artifact and are not a measured digest of the downloaded file. Choose **Use in chat** after download. The model stays in private app storage and is protected by a lease while inference uses it.

Browser preview supports downloading and saving the choice. Native GGUF inference uses the iPhone app. Browser files stay in their browser profile and do not transfer to the phone.

Model sources: [Qwen3.5 0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B), [2B](https://huggingface.co/Qwen/Qwen3.5-2B), [4B](https://huggingface.co/Qwen/Qwen3.5-4B), and the quantization publisher's [0.8B](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF), [2B](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF), [4B](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) repositories. All three selected artifacts declare Apache 2.0.

## Offline female voices

Open **Voices** from chat. Download a speech model once, select its voice, enter text, and tap **Read aloud**. Assistant replies also offer **Read aloud**. **Stop** cancels speech or playback. Voice selection and speed are saved locally. Persona profiles can select a separate voice and speed, or inherit the Voice Studio choices.

| Speech model    | Voices                                 | Approximate native archive |
| --------------- | -------------------------------------- | -------------------------- |
| Kokoro 82M      | Heart, Bella — female American English | 350 MB                     |
| Piper LJ Speech | Linda — female American English        | 116 MB                     |

Speech is generated on the device after download. It does not call a speech service. The iPhone adapter uses Sherpa ONNX and Expo audio; browser preview uses Sherpa ONNX WASM and WebAudio. Browser synthesis and native synthesis have separate download stores.

In browser preview, **Repair offline voices** updates the small speech runtime without reading or downloading voice weights. **Check download** retains complete cached model files and repairs missing files. Large model files are checked by size without SHA scans. Reading supports up to 3,000 characters per passage.

For a fresh local preview host, prepare the real runtime and model files:

```powershell
& ./tools/prepare-offline-speech.ps1
```

Generated browser model/runtime assets are ignored by Git and EAS. Native installs use foreground downloads, check archive size, and unpack the voice. Full archive hashes are skipped. Saving/unpacking has its own visible phase. Older installed builds, including build 2, do not contain the new native speech module. Build 6 (finished 2026-09-29) was the first signed preview with the speech module and finished phone design; the latest installable preview is **build 21** — see the [iPhone installation guide](iphone-installation.md). Physical device execution remains user-side.

Voice sources: [Kokoro model](https://huggingface.co/hexgrad/Kokoro-82M), [Heart and Bella voice definitions](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md), [Piper LJ Speech model card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/high/MODEL_CARD), [Sherpa speech model releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models). Kokoro declares Apache 2.0; the Piper model card identifies its voice dataset as public domain. Bundled inference runtime and pronunciation data retain their own license notices.

The [LJ Speech dataset source](https://keithito.com/LJ-Speech-Dataset/) identifies Linda Johnson as the reader behind the Piper voice's training recordings.

## OpenRouter

Open **Connections**, choose **OpenRouter**, and open **Chat model** or tap **Load models**. The list comes from the public OpenRouter catalog and does not need an API key. Search and choose an exact model ID. Saved providers can be edited, favorited, and removed; removing a connection preserves conversations.

Enter your own OpenRouter key in the app and choose **Save & chat**. **More actions → Test connection** checks the authenticated key endpoint; the public model list alone cannot validate a key. Native keys use secure storage. Browser keys last for the current tab, while the provider and model selection are saved.

Generation prices and available free models depend on OpenRouter's selected model and account. Apple Developer membership does not pay for cloud inference. This feature makes no generation request when loading the catalog or checking a key.

Sources: [OpenRouter quickstart](https://openrouter.ai/docs/quickstart), [public model catalog](https://openrouter.ai/docs/api/api-reference/models/get-models).

## Exercise before automated checks

The requested order is actual app walkthroughs first, followed by targeted automated checks. Evidence receipts are stored under `tmp/` and recorded separately from historical build 2 validation. A browser walkthrough establishes browser behavior; it does not establish physical iPhone installation, audio output, or native inference performance.

The [current walkthrough evidence](implementation/evidence/phone-models-speech-openrouter-2026-09-27.md) records all three voices generating and completing playback with network disabled, both Stop paths, saved selection after a browser restart, actual local model generation, and OpenRouter's genuine public catalog and invalid-key rejection.
