# LM Mini feature inventory

**Research date: September 25, 2026.** Scope: LM Mini on iPhone/iPad and Android, LM Mini Home on macOS, and LM Mini Connect. This is an inventory of public product documentation and store release notes. Features have not been exercised in an installed app. Version-specific and uncertain behavior is marked below.

The product combines a chat interface, model management, reusable characters, voice, tools, media generation, and remote access. A Windows learning implementation needs both a desktop client and, for the sharing features, a companion service. [Product overview](https://lmmini.com/)

## How to read this inventory

IDs identify independently useful capabilities, sometimes with closely related controls grouped together. “Conditional” means the platform, model, server, or build must support it. “Unspecified” means the public sources do not establish a reliable entitlement. Pro labels describe LM Mini, not requirements for your own project.

## 1. Platforms and operating modes

| ID | Capability | Availability / distinction |
| --- | --- | --- |
| PL-01 | iPhone and iPad app | App Store distribution. |
| PL-02 | Android app | Google Play distribution; local GGUF inference. |
| PL-03 | Full Mac app: LM Mini Home | Desktop chat and local models. |
| PL-04 | Windows/Linux Connect companion | Remote bridge; not the full desktop chat client. |
| PL-05 | Completely local chat | Download first; chat offline afterward. |
| PL-06 | LAN chat | Reach an existing model server directly. |
| PL-07 | Remote chat | Encrypted Home/Connect pairing; Pro. |
| PL-08 | Optional hosted providers | User-supplied API credentials. |

Windows Connect is currently offered as an x64 installer, version 1.5.2. Mac Connect is being retired and remains supported through December 31, 2026. [Downloads](https://lmmini.com/download.html), [Connect downloads](https://lmmini.com/connect.html)

## 2. First-run setup

| ID | Capability |
| --- | --- |
| OB-01 | Welcome wizard with Beginner and Power user paths. |
| OB-02 | RAM-aware Faster / Balanced / Best model choices. |
| OB-03 | Download a suggested model during onboarding. |
| OB-04 | Get Started recovery sheet when no model is configured. |
| OB-05 | Choose an initial theme. |
| OB-06 | Optional, skippable model race during setup. |
| OB-07 | Computer setup instructions and LAN IP guidance. |
| OB-08 | LM Studio discovery scan where available; authenticated servers remain discoverable. |

Beginner mode hides advanced settings and can be changed later. Cloud credentials are optional. [Getting started](https://lmmini.com/docs/getting-started.html)

## 3. Provider connections

| ID | Capability / provider | Details |
| --- | --- | --- |
| PR-01 | On-device GGUF | Bundled local inference. |
| PR-02 | On-device MLX | Apple Silicon; preferred where a catalog build exists. |
| PR-03 | LM Studio | Typical port 1234; optional API token. |
| PR-04 | Ollama | Typical port 11434. |
| PR-05 | JAN AI | Local API; typical port 1337; free provider. |
| PR-06 | oMLX | Networked Apple model server. |
| PR-07 | Named cloud integrations | Claude, OpenAI, Gemini, Mistral, OpenRouter, DeepSeek, Z.AI, Vercel AI Gateway. |
| PR-08 | Custom compatible server | OpenAI-compatible URL. |
| PR-09 | Multiple saved connections | Select globally or bind to a chat, Persona, or participant. |
| PR-10 | Custom HTTP headers | Arbitrary headers and Cloudflare Access credentials; separate enable switch. |
| PR-11 | Capability-aware interface | Unsupported provider controls are hidden. |

Cloud integrations require Pro according to this guide; keys stay on the device. [Providers guide](https://lmmini.com/docs/providers.html). Unsloth Desktop is a later addition: see UP-01.

## 4. Model catalog and lifecycle

| ID | Capability |
| --- | --- |
| MO-01 | Searchable catalog; quantization labels. |
| MO-02 | Model fit guidance using RAM, file size, format, and hardware. |
| MO-03 | Background downloads with progress indicators. |
| MO-04 | Hugging Face model downloads. |
| MO-05 | File/MLX-folder import. |
| MO-06 | Downloaded/selected/loaded model management. |
| MO-07 | Browse, download, load, and unload LM Studio models. |
| MO-08 | Ollama downloads. |
| MO-09 | Loading progress. |
| MO-10 | Tool-capable model badge in supported browsers. |

MO-01, MO-05, MO-06, MO-08 and MO-09 appear in the [website release history](https://lmmini.com/changelog.html). MO-04 and MO-07 are advertised in the [Android listing](https://play.google.com/store/apps/details?id=net.neuro9.lmmini). MO-02 is supported by the [model guide](https://lmmini.com/models.html); that web guide also lists models intended for external hosting, so its full list is not the in-app catalog. MO-03 and MO-10 are described in the [providers guide](https://lmmini.com/docs/providers.html). Download cancellation and reload prompts are later additions: UP-04 and UP-05.

## 5. Everyday chat

| ID | Capability |
| --- | --- |
| CH-01 | Token streaming; stop and regenerate controls. |
| CH-02 | Markdown, code blocks, syntax highlighting, and LaTeX math. |
| CH-03 | Separate thinking/reasoning stream where supported. |
| CH-04 | Automatic conversation titles; short greetings may defer naming. |
| CH-05 | Conversation list, folders, and search. |
| CH-06 | Colored folders and image covers; move chats between folders. |
| CH-07 | Per-chat model/provider, sampling, system prompt, and reasoning overrides. |
| CH-08 | Per-chat backgrounds and avatars. |
| CH-09 | Context usage indicator. |
| CH-10 | Stop, Roll, and Cut middle context-overflow policies. |
| CH-11 | Compact older messages into a summary. |
| CH-12 | Modern Shine composer or legacy compact composer. |
| CH-13 | Starter suggestions on/off; Return sends or inserts newline. |
| CH-14 | Streaming auto-scroll and jump-to-bottom. |
| CH-15 | Background reply completion with optional progress notification. |
| CH-16 | Abrupt-ending auto-retry. |
| CH-17 | Stateful LM Studio chat. |

Roll removes older turns; Cut middle preserves the beginning and latest turns. History is fitted to roughly 90% of the loaded context window. Per-chat system instructions supplement Persona/global instructions. [Chat guide](https://lmmini.com/docs/chat.html). CH-16–CH-17 and syntax highlighting: [website release history](https://lmmini.com/changelog.html).

## 6. Attachments, history, and retrieval

| ID | Capability | Evidence / qualification |
| --- | --- | --- |
| AT-01 | Attach images for vision-capable models | [Chat guide](https://lmmini.com/docs/chat.html). |
| AT-02 | MD/XLSX attachments | [Release history](https://lmmini.com/changelog.html); exact full format list unspecified. |
| AT-03 | Open attached photos | [Release history](https://lmmini.com/changelog.html). |
| AT-04 | Copy preserving Markdown | [Release history](https://lmmini.com/changelog.html). |
| AT-05 | Preserve regeneration variants | [Release history](https://lmmini.com/changelog.html); navigation details unspecified. |
| AT-06 | Conversation model/last-use metadata | [Release history](https://lmmini.com/changelog.html). |
| AT-07 | Import LM Studio conversations | [Android listing](https://play.google.com/store/apps/details?id=net.neuro9.lmmini). |
| AT-08 | Semantic conversation search using local embeddings | [Android listing](https://play.google.com/store/apps/details?id=net.neuro9.lmmini). |

Do not infer full document RAG, a vector database UI, or support for every office file type from attachment and semantic-search support. Those details are not established publicly.

## 7. Model parameters and precedence

| ID | Capability |
| --- | --- |
| PA-01 | Temperature, top-p, top-k, min-p, repeat penalty. |
| PA-02 | Maximum output tokens and context-window controls. |
| PA-03 | Reasoning toggle, verbosity, and JSON/structured output where supported. |
| PA-04 | Flash attention and KV-cache offload where supported. |
| PA-05 | Global defaults and model-specific presets. |
| PA-06 | Persona-specific parameter presets. |
| PA-07 | Chat overrides take highest precedence. |
| PA-08 | Reset model preset through Use Global params. |

Effective precedence: global → selected-model preset → enabled Persona preset → chat overrides. Backend support governs which controls apply. [Settings reference](https://lmmini.com/docs/settings.html)

## 8. Personas and memory

| ID | Capability |
| --- | --- |
| PE-01 | Reusable named characters with avatar and system prompt. |
| PE-02 | Preferred provider/model without changing global defaults. |
| PE-03 | Default profile plus built-in Mini assistant. |
| PE-04 | Mini is seeded once; deleting it keeps it deleted. |
| PE-05 | Persona profile pages and appearance editing. |
| PE-06 | AI Persona Generator creates an initial name, prompt, and avatar. |
| PE-07 | App-default, Kokoro, ElevenLabs, or Grok voice binding. |
| PE-08 | Kokoro voice speed and custom parameter binding. |
| PE-09 | Attach a ComfyUI workflow to a Persona. |
| PE-10 | Start individual chats or add Personas to groups. |

Personas are included in the free app. [Persona guide](https://lmmini.com/docs/personas.html), [Persona article](https://lmmini.com/blog/personas.html)

| ID | Memory capability |
| --- | --- |
| ME-01 | Remember facts across conversations. |
| ME-02 | Background extraction and prompt injection. |
| ME-03 | Manage saved entries under Data → Memory. |
| ME-04 | Associate selected facts with specific Personas. |
| ME-05 | Isolate a Persona from the global memory pool. |
| ME-06 | Control Persona memory sharing/generation. |
| ME-07 | Switch Personas without discarding chat context. |

ME-01–ME-06: [Settings reference](https://lmmini.com/docs/settings.html), [Persona article](https://lmmini.com/blog/personas.html). ME-07: [Release history](https://lmmini.com/changelog.html). The exact extraction algorithm and deduplication rules are not public.

## 9. Multi-model group chat

| ID | Capability |
| --- | --- |
| GR-01 | Shared thread with several AI participants. |
| GR-02 | Same model with different roles, or mixed models/providers. |
| GR-03 | Add a saved Persona or a model directly. |
| GR-04 | Participant name, avatar, accent, prompt, model, tools, voice. |
| GR-05 | Ordered round-robin replies. |
| GR-06 | Autonomous/@mention participation. |
| GR-07 | Manual next-speaker selection through Ask chips. |
| GR-08 | Reply-to-user-only option. |
| GR-09 | Parallel streaming. |
| GR-10 | Automatic local model loading/unloading to save memory. |
| GR-11 | User display name and persistent room scenario. |
| GR-12 | Validate participant bindings before starting. |
| GR-13 | Group speech plays participant replies in order. |

Beta feature: free preview allows up to two participants; Pro allows up to five and continued use beyond the preview. Preview duration is unspecified. [Group guide](https://lmmini.com/docs/group-chat.html), [Group article](https://lmmini.com/blog/group-chat.html)

## 10. Voice and transcription

| ID | Capability |
| --- | --- |
| VO-01 | System/native text-to-speech. |
| VO-02 | Local Kokoro neural TTS. |
| VO-03 | Kokoro synthesized by Home/Connect and played on the phone. |
| VO-04 | ElevenLabs and Grok/xAI voices using API keys; Pro. |
| VO-05 | Rate/pitch controls where supported; voice test. |
| VO-06 | Automatically read assistant replies. |
| VO-07 | System speech-to-text with separate recognition language. |
| VO-08 | Whisper model sizes from tiny through large-v3 where offered. |
| VO-09 | macOS system speech recognition. |
| VO-10 | Review dictated text or automatically send it. |
| VO-11 | Continuous listen → send → speak → listen cycle. |
| VO-12 | iOS Call Mode: lock-screen continuation and earpiece routing. |
| VO-13 | Per-Persona/participant voices. |
| VO-14 | Download languages individually. |
| VO-15 | Pause detection and total listening-duration controls. |
| VO-16 | Transcription feature with audio playback. |

English, Spanish, French, and Chinese share a Kokoro pack. German/Russian use Piper voices under the same language-pack surface. [Voice guide](https://lmmini.com/docs/voice.html). VO-15–VO-16: [Release history](https://lmmini.com/changelog.html). General speech flow: [Voice article](https://lmmini.com/blog/voice-chat.html). Audio import formats, diarization, and timestamps are unspecified.

## 11. Tools, search, and MCP

| ID | Capability |
| --- | --- |
| TL-01 | Global tool-use switch with chat/participant overrides. |
| TL-02 | Built-in tools, including current time. |
| TL-03 | Pro Search: hosted web search; Pro. |
| TL-04 | User-configured SearXNG search endpoint. |
| TL-05 | Ephemeral HTTP MCP servers with label, URL, Bearer/custom headers. |
| TL-06 | LM Studio integrated MCP names from its mcp.json. |
| TL-07 | Enable/disable individual integrated MCPs. |
| TL-08 | Python/JavaScript sandbox where offered. |
| TL-09 | Run the tool loop and continue the assistant response. |
| TL-10 | Transcript tool activity and tool errors. |
| TL-11 | Composer chips for per-turn search/tool toggles. |
| TL-12 | Integrated MCP renaming; unlimited-call toggle. |

LM Studio plugins execute on its host; Ollama does not host those plugins. Sandbox execution is described as occurring in a provider worker. Tool-capable models are required. [Tools guide](https://lmmini.com/docs/tools.html). TL-12: [Release history](https://lmmini.com/changelog.html). Exact worker implementation and paid limits are unspecified.

## 12. Images and generated media

| ID | Capability |
| --- | --- |
| IM-01 | Master image-generation toggle. |
| IM-02 | Chat image button; optional prompt review and automatic generation. |
| IM-03 | AUTOMATIC1111 txt2img via reachable API. |
| IM-04 | Checkpoint, sampler, steps, CFG, dimensions, HR fix, face restoration. |
| IM-05 | ComfyUI server connection. |
| IM-06 | Default, pasted API-JSON, or server-saved workflow. |
| IM-07 | Workflow placeholders for generation settings. |
| IM-08 | LoRA name/weight placeholders. |
| IM-09 | Persona workflow binding. |
| IM-10 | Core ML Stable Diffusion on supported iOS builds. |
| IM-11 | Download/select on-device image checkpoints. |
| IM-12 | Mac Home proxies A1111/ComfyUI through phone sharing. |
| IM-13 | ComfyUI video generation is referenced in a fix. |

Placeholders: `%PROMPT%`, `%NEGATIVE%`, `%SEED%`, `%STEPS%`, `%CFG%`, `%WIDTH%`, `%HEIGHT%`, `%SAMPLER%`, `%SCHEDULER%`, `%CHECKPOINT%`, `%LORA%`, `%LORA_WEIGHT%`. Core ML does not mirror the advanced PyTorch LoRA/VAE paths. [Image guide](https://lmmini.com/docs/image-gen.html). IM-13 is release-note evidence only: [Release history](https://lmmini.com/changelog.html). Gallery and queue additions: UP-02–UP-03. Video controls and output formats are unspecified.

## 13. Arena comparisons

| ID | Capability |
| --- | --- |
| AR-01 | Race up to four models against one prompt. |
| AR-02 | Mix local-device, LM Studio, Ollama, oMLX, and cloud contestants. |
| AR-03 | Live output, tokens/sec, and time to first token. |
| AR-04 | Compare written answers side by side. |
| AR-05 | Built-in discovery prompts and suggested race lanes. |
| AR-06 | Race top two; Quick or Full suite. |
| AR-07 | Apply a result as the default model or Persona binding. |
| AR-08 | Pro custom prompts, cloud contestants, history where enabled. |
| AR-09 | Explicit opt-in anonymous benchmark sharing. |

JAN participation is additionally stated in the Arena article. Anonymous sharing is off initially. This is a comparison tool, not evidence of an automatic quality judge. [Arena guide](https://lmmini.com/docs/arena.html), [Arena article](https://lmmini.com/blog/arena.html)

## 14. Remote access and Connect

| ID | Capability |
| --- | --- |
| RE-01 | One-time QR pairing with a shared encryption key. |
| RE-02 | Relay access without port forwarding or VPN. |
| RE-03 | Remote LM Studio, Ollama, and oMLX routing. |
| RE-04 | Remote images and Kokoro audio. |
| RE-05 | Pairing/connection health and backend-specific setup errors. |
| RE-06 | Encryption-key viewing, editing, copying, regeneration. |
| RE-07 | Tray integration and optional automatic startup. |
| RE-08 | Connect Kokoro packs: download/cancel/remove/test. |
| RE-09 | Link an existing voice folder/archive; unlink preserves external files. |
| RE-10 | Compatibility prompts for older app/Connect versions. |
| RE-11 | iPhone-to-Mac USB proxy, automatic detection, tray status. |

Remote use is Pro. USB is described as free/beta and mutually exclusive with remote pairing; Windows USB parity is not established. [Remote guide](https://lmmini.com/docs/connect.html). RE-04 image forwarding: [Image guide](https://lmmini.com/docs/image-gen.html). RE-03, RE-06–RE-08, RE-10–RE-11 and RE-09 unlink behavior: [Release history](https://lmmini.com/changelog.html). RE-09 import paths: [Voice guide](https://lmmini.com/docs/voice.html). The relay protocol and crypto algorithm are not specified by these pages.

## 15. Device synchronization

| ID | Capability |
| --- | --- |
| SY-01 | Optional real-time phone ↔ Home chat synchronization. |
| SY-02 | Pairing-time prompt or later Sync chats with Home switch. |
| SY-03 | Copy one side or merge both sides. |
| SY-04 | Sync messages and folders, including names/covers. |
| SY-05 | Propagate chat/folder deletes. |
| SY-06 | Newer edit wins for a shared conversation. |
| SY-07 | Disable sync while retaining local copies. |
| SY-08 | Sync failure notification and retry by toggling. |
| SY-09 | Optional Apple iCloud synchronization. |
| SY-10 | Selectively synchronize Personas, including photos/memories. |

SY-01–SY-08: [Sync guide](https://lmmini.com/docs/sync.html). It excludes Windows/Linux Connect and excludes settings, themes, credentials, models, voice packs, and image workflows. SY-09: [Privacy policy](https://lmmini.com/privacy.html). SY-10: Home 1.9.8 [release notes](https://lmmini.com/changelog.html). The guide still excludes Personas; newer release notes supersede that part. SY-10 requires Home chat sync to be enabled. Exact cross-platform rollout needs verification.

## 16. Appearance, usability, and desktop shell

| ID | Capability |
| --- | --- |
| UI-01 | Light/dark, built-in/custom themes, live editor, fonts, bubbles, gradients. |
| UI-02 | Community theme sharing/downloads. |
| UI-03 | Background image/dimming and avatar choice/placement/visibility. |
| UI-04 | Font family/size; avatar size. |
| UI-05 | Glass effect toggle. |
| UI-06 | Low battery mode: reduced effects, plain streaming text, deferred sync. |
| UI-07 | Full-width assistant replies; later default. |
| UI-08 | iOS default/dark/glass app icons. |
| UI-09 | Apple Pencil scroll/selection behavior. |
| UI-10 | Landscape phone two-column layout; native iPad layout. |
| UI-11 | Desktop navigation rail, chat list beside conversation. |
| UI-12 | Desktop Chats, Personas, Settings, Arena, Nerds panes. |
| UI-13 | Mac Command+1 through Command+5 navigation. |
| UI-14 | Two-pane desktop/tablet Settings. |
| UI-15 | Home menu-bar sharing service. |
| UI-16 | Nerds: runtime, connection, analytics, services diagnostics. |
| UI-17 | Select UI language or follow system locale. |
| UI-18 | Declared accessibility: dark interface, non-color-only distinctions, contrast. |
| UI-19 | Analytics dashboard. |

UI-01–UI-03, UI-08–UI-09, UI-14, UI-17: [Settings reference](https://lmmini.com/docs/settings.html). UI-02, UI-04–UI-06, UI-10, UI-19: [Release history](https://lmmini.com/changelog.html). UI-07: [Android release notes](https://play.google.com/store/apps/details?id=net.neuro9.lmmini), with the later default and UI-18 in the [App Store listing](https://apps.apple.com/us/app/lm-mini/id6751125309). UI-11–UI-13, UI-15–UI-16: [Desktop guide](https://lmmini.com/docs/desktop.html).

## 17. Data, security, account, and support

| ID | Capability | Qualification |
| --- | --- | --- |
| DA-01 | Persistent local history, settings, Personas, server URLs | Local-first storage. |
| DA-02 | Export one chat as PDF/TXT; all chats as ZIP | Settings reference. |
| DA-03 | Optional encrypted cloud backup | Passphrase chosen by user; Pro. |
| DA-04 | Optional product analytics | Described as excluding chat text/prompts. |
| DA-05 | App Lock PIN | Pro; 4 or 6 digits. |
| DA-06 | Lock grace period | Immediate, 15 seconds, 1/5/15 minutes, 1 hour. |
| DA-07 | Device-local salted PIN hash | Not synced or backed up; lock survives Pro lapse. |
| DA-08 | Biometric unlock and account-assisted PIN recovery | Later release notes; see UP-06. |
| DA-09 | Cold-start PIN challenge; PIN required to disable lock | Device-local policy. |
| AC-01 | Anonymous account, optional Apple/Google/email linking | Production service integration. |
| AC-02 | Email password recovery | Release history. |
| AC-03 | Monthly, yearly, lifetime Pro; purchase restoration/activation guidance | Store services. |
| AC-04 | Apple Family Sharing | Store-dependent entitlement. |
| AC-05 | In-app support and feature requests | Voting, comments/replies, unread indicators. |
| AC-06 | Support attachments; chat entry | Release history. |
| AC-07 | In-app changelog and update/version checks | Product maintenance. |
| AC-08 | Community theme and voice catalogs | Production database services. |

DA-02, DA-05–DA-07, DA-09 and voting: [Settings reference](https://lmmini.com/docs/settings.html). DA-01, DA-03–DA-04, AC-01, AC-07–AC-08: [Privacy policy](https://lmmini.com/privacy.html). AC-02, AC-05–AC-07 and AC-03 activation guidance: [Release history](https://lmmini.com/changelog.html). AC-03 purchase types: [Purchase terms](https://lmmini.com/terms.html). AC-04: [App Store](https://apps.apple.com/us/app/lm-mini/id6751125309).

Observed US App Store prices: $4.99 monthly, $29.99 yearly, $119.99 lifetime. These are a dated snapshot; provider API fees are separate. [App Store](https://apps.apple.com/us/app/lm-mini/id6751125309), [Purchase terms](https://lmmini.com/terms.html)

## 18. Widgets, automation, and reusable workflows

| ID | Capability |
| --- | --- |
| AU-01 | iOS Home Screen/Control Center widgets: new chat, camera, news where offered. |
| AU-02 | Download Lock Screen/Dynamic Island progress; generation Live Activity. |
| AU-03 | Siri, Action Button, Share Sheet, and scheduled Shortcuts entry points. |
| AU-04 | App Intents: ask, search, voice chat, summarize, translate, news brief. |
| AU-05 | lmmini://shortcut/... deep-link family. |
| AU-06 | OCR-oriented screenshot and business-card workflows. |
| AU-07 | Retain context between Shortcut runs through variables/files. |
| AU-08 | Spoken search and news/weather brief workflows. |

AU-01–AU-02: [Settings reference](https://lmmini.com/docs/settings.html). AU-03–AU-08: [Shortcuts catalog](https://lmmini.com/shortcuts/). Available recipes: article summary; meeting minutes; Speech Shrink; unChatGPTfy; email rephrase; writing help; stories; social posts; emotional support; screenshot chat; business-card scanner; recipes; groceries; tourist guide; weather; CtxLLM; search; on-device spoken questions; voice chat; CallKit call; clipboard translation; morning news. These are packaged workflows, not separate model capabilities. Exact deep-link parameters are not provided by the current reference link.

## 19. Newer store additions and corrections

Observed iOS releases extend through 1.9.10; additions below are version-specific. [App Store release history](https://apps.apple.com/us/app/lm-mini/id6751125309)

| ID | Addition | Version |
| --- | --- | --- |
| UP-01 | Free local Unsloth Desktop compatible provider | 1.9.9 / 1.9.10. |
| UP-02 | Generated-image gallery, including chat menu access | 1.9.9 / 1.9.10. |
| UP-03 | ComfyUI generation queue | 1.9.9. |
| UP-04 | Cancel Hugging Face/LM Studio downloads | 1.9.5. |
| UP-05 | Reload prompt after changing context; linked image/chat server update prompts | 1.9.5. |
| UP-06 | Face ID/Touch ID/fingerprint unlock; emailed PIN recovery link | 1.9.5. |
| UP-07 | Compress an oversized attached image and resend | 1.9.8; also in Android notes. |
| UP-08 | Hide embedding models from chat-model selection | 1.9.10. |

Google Play also lists Persona sync, full-width replies, and image compression; it does not establish all newer iOS additions. [Android release notes](https://play.google.com/store/apps/details?id=net.neuro9.lmmini)

## 20. Failure handling is part of the feature scope

| ID | Required behavior reflected by public sources |
| --- | --- |
| ER-01 | Provider-specific connection guidance. |
| ER-02 | Distinguish URL/token/network errors from model incompatibility. |
| ER-03 | Show model/context/tool/voice/sync setup failures. |
| ER-04 | Missing model banner with selection recovery. |
| ER-05 | Report host termination and context/max-token causes. |
| ER-06 | Identify unavailable image servers, missing checkpoints/workflows, and MCP failures. |
| ER-07 | Recover sharing connection after host sleep. |
| ER-08 | Cancel stopped-reply memory extraction. |

ER-01–ER-03: [Troubleshooting guide](https://lmmini.com/docs/troubleshooting.html). ER-04: [Website release history](https://lmmini.com/changelog.html). ER-05 and ER-07: [Android release notes](https://play.google.com/store/apps/details?id=net.neuro9.lmmini). ER-06 and ER-08: [App Store release history](https://apps.apple.com/us/app/lm-mini/id6751125309). Exact error strings are not requirements for the Windows project.

## Coverage boundary

This catalog covers every feature family found in the public docs index, product/download pages, complete visible website release history, relevant product articles, Shortcuts catalog, privacy/services description, and both store listings. It is not a claim of exhaustive hidden-setting or binary-level parity. The [research notes](../archived/docs/research-notes.md) record contradictions and details that need an installed-app audit. The archived [Windows blueprint](../archived/docs/windows-blueprint.md) preserves an earlier design proposal; use the [current plan](../plans/README.md) for implementation work.
