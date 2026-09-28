# Feature coverage and verification ledger

This ledger maps all **231** records in the [source inventory](../docs/lm-mini-features.md) to implementation cards, a working-build milestone and a later deep-verification shard. The sequence is **working code first, deep testing second**. T158 proves the first offline and OpenAI remote chat; T128 integrates the iPhone feature routes. Domain shards T159A–H then verify real iPhone/device/service behavior for T159. T157/Android T129–T132/desktop T134 are later working builds; T160–T169 check their platform differences before T121/T135.

A feature row is *implemented* when its card and working route pass a bounded smoke check. It is *verified* only when the listed deep shard has real applicable evidence and T121 accepts later-platform parity. Hardware-inapplicable behavior needs an explicit reason, never a dummy control. Coordinator status links proof artifacts to each ID **and platform**.

## PL — Platforms and access (8)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| PL-01 | iPhone and iPad app | [T001](tasks/P00/T001.md), [T128](tasks/P11/T128.md), [T157](tasks/P11/T157.md) | iPhone T128; iPad T157 | T159A; T163 |
| PL-02 | Android app | [T129](tasks/P11/T129.md), [T135](tasks/P11/T135.md), [T001A](tasks/P00/T001A.md) | Android T129–T132 | T160–T162, T168–T169 |
| PL-03 | Full Mac app: LM Mini Home | [T134](tasks/P11/T134.md), [T001A](tasks/P00/T001A.md) | desktop T134 | T164–T166 |
| PL-04 | Windows/Linux Connect companion | [T134](tasks/P11/T134.md), [T001A](tasks/P00/T001A.md) | desktop T134 | T164–T166 |
| PL-05 | Completely local chat | [T029](tasks/P03/T029.md), [T036](tasks/P03/T036.md), [T158](tasks/P04/T158.md) | first offline chat T158; full iPhone T128 | T159A |
| PL-06 | LAN chat | [T025](tasks/P02/T025.md) | iPhone T128 | T159A |
| PL-07 | Remote chat | [T096](tasks/P09/T096.md) | iPhone T128 | T159D |
| PL-08 | Optional hosted providers | [T021A](tasks/P02/T021A.md), [T023](tasks/P02/T023.md), [T158](tasks/P04/T158.md) | OpenAI text T158; broader providers T128 | T159A |

## OB — Onboarding (8)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| OB-01 | Welcome wizard with Beginner and Power user paths. | [T035](tasks/P03/T035.md) | iPhone T128 | T159A |
| OB-02 | RAM-aware Faster / Balanced / Best model choices. | [T035](tasks/P03/T035.md) | iPhone T128 | T159A |
| OB-03 | Download a suggested model during onboarding. | [T035](tasks/P03/T035.md) | iPhone T128 | T159A |
| OB-04 | Get Started recovery sheet when no model is configured. | [T035](tasks/P03/T035.md) | iPhone T128 | T159A |
| OB-05 | Choose an initial theme. | [T035](tasks/P03/T035.md) | iPhone T128 | T159A |
| OB-06 | Optional, skippable model race during setup. | [T035](tasks/P03/T035.md) | iPhone T128 | T159A |
| OB-07 | Computer setup instructions and LAN IP guidance. | [T024](tasks/P02/T024.md) | iPhone T128 | T159A |
| OB-08 | LM Studio discovery scan where available; authenticated servers remain discoverable. | [T024](tasks/P02/T024.md) | iPhone T128 | T159A |

## PR — Providers (11)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| PR-01 | On-device GGUF | [T026](tasks/P03/T026.md), [T027](tasks/P03/T027.md) | iPhone T128 | T159A |
| PR-02 | On-device MLX | [T028](tasks/P03/T028.md), [T030](tasks/P03/T030.md) | iPhone T128 | T159A |
| PR-03 | LM Studio | [T018](tasks/P02/T018.md) | iPhone T128 | T159A |
| PR-04 | Ollama | [T017](tasks/P02/T017.md) | iPhone T128 | T159A |
| PR-05 | JAN AI | [T020](tasks/P02/T020.md) | iPhone T128 | T159A |
| PR-06 | oMLX | [T020](tasks/P02/T020.md) | iPhone T128 | T159A |
| PR-07 | Named cloud integrations | [T021A](tasks/P02/T021A.md), [T021](tasks/P02/T021.md), [T022](tasks/P02/T022.md), [T023](tasks/P02/T023.md), [T158](tasks/P04/T158.md) | OpenAI text T158; full named-cloud set T128 | T159A |
| PR-08 | Custom compatible server | [T020](tasks/P02/T020.md) | iPhone T128 | T159A |
| PR-09 | Multiple saved connections | [T024](tasks/P02/T024.md) | iPhone T128 | T159A |
| PR-10 | Custom HTTP headers | [T024](tasks/P02/T024.md) | iPhone T128 | T159A |
| PR-11 | Capability-aware interface | [T015](tasks/P01/T015.md) | iPhone T128 | T159A |

## MO — Model management (10)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| MO-01 | Searchable catalog; quantization labels. | [T033](tasks/P03/T033.md) | iPhone T128 | T159A |
| MO-02 | Model fit guidance using RAM, file size, format, and hardware. | [T035](tasks/P03/T035.md) | iPhone T128 | T159A |
| MO-03 | Background downloads with progress indicators. | [T031](tasks/P03/T031.md), [T032](tasks/P03/T032.md) | iPhone T128 | T159A |
| MO-04 | Hugging Face model downloads. | [T033](tasks/P03/T033.md) | iPhone T128 | T159A |
| MO-05 | File/MLX-folder import. | [T033](tasks/P03/T033.md) | iPhone T128 | T159A |
| MO-06 | Downloaded/selected/loaded model management. | [T033](tasks/P03/T033.md) | iPhone T128 | T159A |
| MO-07 | Browse, download, load, and unload LM Studio models. | [T034](tasks/P03/T034.md) | iPhone T128 | T159A |
| MO-08 | Ollama downloads. | [T019](tasks/P02/T019.md) | iPhone T128 | T159A |
| MO-09 | Loading progress. | [T034](tasks/P03/T034.md) | iPhone T128 | T159A |
| MO-10 | Tool-capable model badge in supported browsers. | [T015](tasks/P01/T015.md) | iPhone T128 | T159A |

## CH — Chat (17)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| CH-01 | Token streaming; stop and regenerate controls. | [T037A](tasks/P04/T037A.md) | first local/OpenAI chat T158; full iPhone T128 | T159F |
| CH-02 | Markdown, code blocks, syntax highlighting, and LaTeX math. | [T039](tasks/P04/T039.md), [T040](tasks/P04/T040.md) | iPhone T128 | T159F |
| CH-03 | Separate thinking/reasoning stream where supported. | [T037](tasks/P04/T037.md) | iPhone T128 | T159F |
| CH-04 | Automatic conversation titles; short greetings may defer naming. | [T037](tasks/P04/T037.md) | iPhone T128 | T159F |
| CH-05 | Conversation list, folders, and search. | [T042](tasks/P04/T042.md) | iPhone T128 | T159F |
| CH-06 | Colored folders and image covers; move chats between folders. | [T042](tasks/P04/T042.md) | iPhone T128 | T159F |
| CH-07 | Per-chat model/provider, sampling, system prompt, and reasoning overrides. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| CH-08 | Per-chat backgrounds and avatars. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| CH-09 | Context usage indicator. | [T037](tasks/P04/T037.md) | iPhone T128 | T159F |
| CH-10 | Stop, Roll, and Cut middle context-overflow policies. | [T037](tasks/P04/T037.md) | iPhone T128 | T159F |
| CH-11 | Compact older messages into a summary. | [T037](tasks/P04/T037.md) | iPhone T128 | T159F |
| CH-12 | Modern Shine composer or legacy compact composer. | [T041](tasks/P04/T041.md) | iPhone T128 | T159F |
| CH-13 | Starter suggestions on/off; Return sends or inserts newline. | [T041](tasks/P04/T041.md) | iPhone T128 | T159F |
| CH-14 | Streaming auto-scroll and jump-to-bottom. | [T039](tasks/P04/T039.md) | iPhone T128 | T159F |
| CH-15 | Background reply completion with optional progress notification. | [T047](tasks/P04/T047.md), [T048](tasks/P04/T048.md) | iPhone T128 | T159F |
| CH-16 | Abrupt-ending auto-retry. | [T037](tasks/P04/T037.md) | iPhone T128 | T159F |
| CH-17 | Stateful LM Studio chat. | [T018](tasks/P02/T018.md) | iPhone T128 | T159F |

## AT — Attachments and history (8)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| AT-01 | Attach images for vision-capable models | [T043](tasks/P04/T043.md) | iPhone T128 | T159F |
| AT-02 | MD/XLSX attachments | [T043](tasks/P04/T043.md) | iPhone T128 | T159F |
| AT-03 | Open attached photos | [T043](tasks/P04/T043.md) | iPhone T128 | T159F |
| AT-04 | Copy preserving Markdown | [T039](tasks/P04/T039.md) | iPhone T128 | T159F |
| AT-05 | Preserve regeneration variants | [T038](tasks/P04/T038.md) | iPhone T128 | T159F |
| AT-06 | Conversation model/last-use metadata | [T038](tasks/P04/T038.md) | iPhone T128 | T159F |
| AT-07 | Import LM Studio conversations | [T044](tasks/P04/T044.md) | iPhone T128 | T159F |
| AT-08 | Semantic conversation search using local embeddings | [T045](tasks/P04/T045.md) | iPhone T128 | T159F |

## PA — Parameters (8)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| PA-01 | Temperature, top-p, top-k, min-p, repeat penalty. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| PA-02 | Maximum output tokens and context-window controls. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| PA-03 | Reasoning toggle, verbosity, and JSON/structured output where supported. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| PA-04 | Flash attention and KV-cache offload where supported. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| PA-05 | Global defaults and model-specific presets. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| PA-06 | Persona-specific parameter presets. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| PA-07 | Chat overrides take highest precedence. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |
| PA-08 | Reset model preset through Use Global params. | [T046](tasks/P04/T046.md) | iPhone T128 | T159F |

## PE — Personas (10)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| PE-01 | Reusable named characters with avatar and system prompt. | [T050](tasks/P05/T050.md) | iPhone T128 | T159B |
| PE-02 | Preferred provider/model without changing global defaults. | [T054](tasks/P05/T054.md) | iPhone T128 | T159B |
| PE-03 | Default profile plus built-in Mini assistant. | [T050](tasks/P05/T050.md) | iPhone T128 | T159B |
| PE-04 | Mini is seeded once; deleting it keeps it deleted. | [T050](tasks/P05/T050.md) | iPhone T128 | T159B |
| PE-05 | Persona profile pages and appearance editing. | [T050](tasks/P05/T050.md) | iPhone T128 | T159B |
| PE-06 | AI Persona Generator creates an initial name, prompt, and avatar. | [T051](tasks/P05/T051.md) | iPhone T128 | T159B |
| PE-07 | App-default, Kokoro, ElevenLabs, or Grok voice binding. | [T054](tasks/P05/T054.md) | iPhone T128 | T159B |
| PE-08 | Kokoro voice speed and custom parameter binding. | [T054](tasks/P05/T054.md) | iPhone T128 | T159B |
| PE-09 | Attach a ComfyUI workflow to a Persona. | [T054](tasks/P05/T054.md), [T091](tasks/P08/T091.md) | iPhone T128 | T159B |
| PE-10 | Start individual chats or add Personas to groups. | [T050](tasks/P05/T050.md) | iPhone T128 | T159B |

## ME — Memory (7)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| ME-01 | Remember facts across conversations. | [T052](tasks/P05/T052.md) | iPhone T128 | T159B |
| ME-02 | Background extraction and prompt injection. | [T052](tasks/P05/T052.md) | iPhone T128 | T159B |
| ME-03 | Manage saved entries under Data → Memory. | [T052](tasks/P05/T052.md) | iPhone T128 | T159B |
| ME-04 | Associate selected facts with specific Personas. | [T053](tasks/P05/T053.md) | iPhone T128 | T159B |
| ME-05 | Isolate a Persona from the global memory pool. | [T053](tasks/P05/T053.md) | iPhone T128 | T159B |
| ME-06 | Control Persona memory sharing/generation. | [T053](tasks/P05/T053.md) | iPhone T128 | T159B |
| ME-07 | Switch Personas without discarding chat context. | [T053](tasks/P05/T053.md) | iPhone T128 | T159B |

## GR — Group chat (13)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| GR-01 | Shared thread with several AI participants. | [T055](tasks/P05/T055.md) | iPhone T128 | T159B |
| GR-02 | Same model with different roles, or mixed models/providers. | [T055](tasks/P05/T055.md) | iPhone T128 | T159B |
| GR-03 | Add a saved Persona or a model directly. | [T055](tasks/P05/T055.md) | iPhone T128 | T159B |
| GR-04 | Participant name, avatar, accent, prompt, model, tools, voice. | [T055](tasks/P05/T055.md) | iPhone T128 | T159B |
| GR-05 | Ordered round-robin replies. | [T056](tasks/P05/T056.md) | iPhone T128 | T159B |
| GR-06 | Autonomous/@mention participation. | [T056](tasks/P05/T056.md) | iPhone T128 | T159B |
| GR-07 | Manual next-speaker selection through Ask chips. | [T056](tasks/P05/T056.md) | iPhone T128 | T159B |
| GR-08 | Reply-to-user-only option. | [T056](tasks/P05/T056.md) | iPhone T128 | T159B |
| GR-09 | Parallel streaming. | [T057](tasks/P05/T057.md) | iPhone T128 | T159B |
| GR-10 | Automatic local model loading/unloading to save memory. | [T057](tasks/P05/T057.md) | iPhone T128 | T159B |
| GR-11 | User display name and persistent room scenario. | [T055](tasks/P05/T055.md) | iPhone T128 | T159B |
| GR-12 | Validate participant bindings before starting. | [T055](tasks/P05/T055.md) | iPhone T128 | T159B |
| GR-13 | Group speech plays participant replies in order. | [T058](tasks/P05/T058.md), [T081](tasks/P07/T081.md) | iPhone T128 | T159B |

## VO — Voice (16)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| VO-01 | System/native text-to-speech. | [T072](tasks/P07/T072.md), [T073](tasks/P07/T073.md), [T133](tasks/P11/T133.md) | iPhone T128 | T159C |
| VO-02 | Local Kokoro neural TTS. | [T075](tasks/P07/T075.md) | iPhone T128 | T159C |
| VO-03 | Kokoro synthesized by Home/Connect and played on the phone. | [T076](tasks/P07/T076.md) | iPhone T128 | T159C |
| VO-04 | ElevenLabs and Grok/xAI voices using API keys; Pro. | [T079](tasks/P07/T079.md) | iPhone T128 | T159C |
| VO-05 | Rate/pitch controls where supported; voice test. | [T080](tasks/P07/T080.md) | iPhone T128 | T159C |
| VO-06 | Automatically read assistant replies. | [T080](tasks/P07/T080.md) | iPhone T128 | T159C |
| VO-07 | System speech-to-text with separate recognition language. | [T072](tasks/P07/T072.md), [T073](tasks/P07/T073.md) | iPhone T128 | T159C |
| VO-08 | Whisper model sizes from tiny through large-v3 where offered. | [T077](tasks/P07/T077.md), [T078](tasks/P07/T078.md), [T130](tasks/P11/T130.md) | iPhone T128 | T159C |
| VO-09 | macOS system speech recognition. | [T074](tasks/P07/T074.md) | iPhone T128 | T159C |
| VO-10 | Review dictated text or automatically send it. | [T072](tasks/P07/T072.md), [T073](tasks/P07/T073.md) | iPhone T128 | T159C |
| VO-11 | Continuous listen → send → speak → listen cycle. | [T081](tasks/P07/T081.md), [T082](tasks/P07/T082.md), [T131](tasks/P11/T131.md) | iPhone T128 | T159C |
| VO-12 | iOS Call Mode: lock-screen continuation and earpiece routing. | [T081](tasks/P07/T081.md) | iPhone T128 | T159C |
| VO-13 | Per-Persona/participant voices. | [T058](tasks/P05/T058.md), [T083](tasks/P07/T083.md) | iPhone T128 | T159C |
| VO-14 | Download languages individually. | [T075](tasks/P07/T075.md) | iPhone T128 | T159C |
| VO-15 | Pause detection and total listening-duration controls. | [T080](tasks/P07/T080.md) | iPhone T128 | T159C |
| VO-16 | Transcription feature with audio playback. | [T080](tasks/P07/T080.md) | iPhone T128 | T159C |

## TL — Tools (12)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| TL-01 | Global tool-use switch with chat/participant overrides. | [T062](tasks/P06/T062.md) | iPhone T128 | T159G |
| TL-02 | Built-in tools, including current time. | [T066](tasks/P06/T066.md) | iPhone T128 | T159G |
| TL-03 | Pro Search: hosted web search; Pro. | [T067](tasks/P06/T067.md) | iPhone T128 | T159G |
| TL-04 | User-configured SearXNG search endpoint. | [T063](tasks/P06/T063.md) | iPhone T128 | T159G |
| TL-05 | Ephemeral HTTP MCP servers with label, URL, Bearer/custom headers. | [T064](tasks/P06/T064.md) | iPhone T128 | T159G |
| TL-06 | LM Studio integrated MCP names from its mcp.json. | [T065](tasks/P06/T065.md) | iPhone T128 | T159G |
| TL-07 | Enable/disable individual integrated MCPs. | [T065](tasks/P06/T065.md) | iPhone T128 | T159G |
| TL-08 | Python/JavaScript sandbox where offered. | [T068](tasks/P06/T068.md) | iPhone T128 | T159G |
| TL-09 | Run the tool loop and continue the assistant response. | [T062](tasks/P06/T062.md) | iPhone T128 | T159G |
| TL-10 | Transcript tool activity and tool errors. | [T069](tasks/P06/T069.md) | iPhone T128 | T159G |
| TL-11 | Composer chips for per-turn search/tool toggles. | [T069](tasks/P06/T069.md) | iPhone T128 | T159G |
| TL-12 | Integrated MCP renaming; unlimited-call toggle. | [T066](tasks/P06/T066.md) | iPhone T128 | T159G |

## IM — Images and media (13)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| IM-01 | Master image-generation toggle. | [T084](tasks/P08/T084.md) | iPhone T128 | T159C |
| IM-02 | Chat image button; optional prompt review and automatic generation. | [T084](tasks/P08/T084.md) | iPhone T128 | T159C |
| IM-03 | AUTOMATIC1111 txt2img via reachable API. | [T085](tasks/P08/T085.md) | iPhone T128 | T159C |
| IM-04 | Checkpoint, sampler, steps, CFG, dimensions, HR fix, face restoration. | [T085](tasks/P08/T085.md) | iPhone T128 | T159C |
| IM-05 | ComfyUI server connection. | [T086](tasks/P08/T086.md) | iPhone T128 | T159C |
| IM-06 | Default, pasted API-JSON, or server-saved workflow. | [T086](tasks/P08/T086.md) | iPhone T128 | T159C |
| IM-07 | Workflow placeholders for generation settings. | [T086](tasks/P08/T086.md) | iPhone T128 | T159C |
| IM-08 | LoRA name/weight placeholders. | [T086](tasks/P08/T086.md) | iPhone T128 | T159C |
| IM-09 | Persona workflow binding. | [T091](tasks/P08/T091.md) | iPhone T128 | T159C |
| IM-10 | Core ML Stable Diffusion on supported iOS builds. | [T088](tasks/P08/T088.md) | iPhone T128 | T159C |
| IM-11 | Download/select on-device image checkpoints. | [T088](tasks/P08/T088.md) | iPhone T128 | T159C |
| IM-12 | Mac Home proxies A1111/ComfyUI through phone sharing. | [T097](tasks/P09/T097.md) | iPhone T128 | T159C |
| IM-13 | ComfyUI video generation is referenced in a fix. | [T087](tasks/P08/T087.md) | iPhone T128 | T159C |

## AR — Arena (9)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| AR-01 | Race up to four models against one prompt. | [T059](tasks/P05/T059.md) | iPhone T128 | T159G |
| AR-02 | Mix local-device, LM Studio, Ollama, oMLX, and cloud contestants. | [T059](tasks/P05/T059.md) | iPhone T128 | T159G |
| AR-03 | Live output, tokens/sec, and time to first token. | [T059](tasks/P05/T059.md) | iPhone T128 | T159G |
| AR-04 | Compare written answers side by side. | [T059](tasks/P05/T059.md) | iPhone T128 | T159G |
| AR-05 | Built-in discovery prompts and suggested race lanes. | [T060](tasks/P05/T060.md) | iPhone T128 | T159G |
| AR-06 | Race top two; Quick or Full suite. | [T060](tasks/P05/T060.md) | iPhone T128 | T159G |
| AR-07 | Apply a result as the default model or Persona binding. | [T060](tasks/P05/T060.md) | iPhone T128 | T159G |
| AR-08 | Pro custom prompts, cloud contestants, history where enabled. | [T060](tasks/P05/T060.md), [T107](tasks/P10/T107.md) | iPhone T128 | T159G |
| AR-09 | Explicit opt-in anonymous benchmark sharing. | [T060](tasks/P05/T060.md), [T118](tasks/P10/T118.md) | iPhone T128 | T159G |

## RE — Remote companion (11)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| RE-01 | One-time QR pairing with a shared encryption key. | [T093](tasks/P09/T093.md) | iPhone T128 | T159D |
| RE-02 | Relay access without port forwarding or VPN. | [T094](tasks/P09/T094.md) | iPhone T128 | T159D |
| RE-03 | Remote LM Studio, Ollama, and oMLX routing. | [T095](tasks/P09/T095.md) | iPhone T128 | T159D |
| RE-04 | Remote images and Kokoro audio. | [T097](tasks/P09/T097.md) | iPhone T128 | T159D |
| RE-05 | Pairing/connection health and backend-specific setup errors. | [T095](tasks/P09/T095.md) | iPhone T128 | T159D |
| RE-06 | Encryption-key viewing, editing, copying, regeneration. | [T093](tasks/P09/T093.md) | iPhone T128 | T159D |
| RE-07 | Tray integration and optional automatic startup. | [T102](tasks/P09/T102.md) | iPhone T128 | T159D |
| RE-08 | Connect Kokoro packs: download/cancel/remove/test. | [T076](tasks/P07/T076.md) | iPhone T128 | T159D |
| RE-09 | Link an existing voice folder/archive; unlink preserves external files. | [T076](tasks/P07/T076.md) | iPhone T128 | T159D |
| RE-10 | Compatibility prompts for older app/Connect versions. | [T102](tasks/P09/T102.md) | iPhone T128 | T159D |
| RE-11 | iPhone-to-Mac USB proxy, automatic detection, tray status. | [T101](tasks/P09/T101.md) | iPhone T128 | T159D |

## SY — Synchronization (10)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| SY-01 | Optional real-time phone ↔ Home chat synchronization. | [T098](tasks/P09/T098.md), [T098C](tasks/P09/T098C.md) | iPhone T128 | T159D |
| SY-02 | Pairing-time prompt or later Sync chats with Home switch. | [T098](tasks/P09/T098.md), [T098A](tasks/P09/T098A.md) | iPhone T128 | T159D |
| SY-03 | Copy one side or merge both sides. | [T098](tasks/P09/T098.md), [T098A](tasks/P09/T098A.md) | iPhone T128 | T159D |
| SY-04 | Sync messages and folders, including names/covers. | [T098](tasks/P09/T098.md), [T098B](tasks/P09/T098B.md) | iPhone T128 | T159D |
| SY-05 | Propagate chat/folder deletes. | [T098](tasks/P09/T098.md), [T098B](tasks/P09/T098B.md) | iPhone T128 | T159D |
| SY-06 | Newer edit wins for a shared conversation. | [T098](tasks/P09/T098.md), [T098B](tasks/P09/T098B.md) | iPhone T128 | T159D |
| SY-07 | Disable sync while retaining local copies. | [T098](tasks/P09/T098.md), [T098A](tasks/P09/T098A.md) | iPhone T128 | T159D |
| SY-08 | Sync failure notification and retry by toggling. | [T098](tasks/P09/T098.md), [T098C](tasks/P09/T098C.md) | iPhone T128 | T159D |
| SY-09 | Optional Apple iCloud synchronization. | [T100](tasks/P09/T100.md) | iPhone T128 | T159D |
| SY-10 | Selectively synchronize Personas, including photos/memories. | [T099](tasks/P09/T099.md) | iPhone T128 | T159D |

## UI — Interface (19)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| UI-01 | Light/dark, built-in/custom themes, live editor, fonts, bubbles, gradients. | [T104](tasks/P10/T104.md), [T105](tasks/P10/T105.md) | iPhone T128 | T159H |
| UI-02 | Community theme sharing/downloads. | [T106](tasks/P10/T106.md) | iPhone T128 | T159E |
| UI-03 | Background image/dimming and avatar choice/placement/visibility. | [T104](tasks/P10/T104.md), [T105](tasks/P10/T105.md) | iPhone T128 | T159H |
| UI-04 | Font family/size; avatar size. | [T104](tasks/P10/T104.md), [T105](tasks/P10/T105.md) | iPhone T128 | T159H |
| UI-05 | Glass effect toggle. | [T120](tasks/P10/T120.md) | iPhone T128 | T159H |
| UI-06 | Low battery mode: reduced effects, plain streaming text, deferred sync. | [T120](tasks/P10/T120.md) | iPhone T128 | T159H |
| UI-07 | Full-width assistant replies; later default. | [T120](tasks/P10/T120.md) | iPhone T128 | T159H |
| UI-08 | iOS default/dark/glass app icons. | [T120](tasks/P10/T120.md) | iPhone T128 | T159H |
| UI-09 | Apple Pencil scroll/selection behavior. | [T119B](tasks/P10/T119B.md) | iPad T157 | T163 |
| UI-10 | Landscape phone two-column layout; native iPad layout. | [T119](tasks/P10/T119.md), [T119B](tasks/P10/T119B.md) | iPhone T128; iPad T157 | T159H; T163 |
| UI-11 | Desktop navigation rail, chat list beside conversation. | [T040](tasks/P04/T040.md) | desktop T134 | T164–T166 |
| UI-12 | Desktop Chats, Personas, Settings, Arena, Nerds panes. | [T040](tasks/P04/T040.md) | desktop T134 | T164–T166 |
| UI-13 | Mac Command+1 through Command+5 navigation. | [T040](tasks/P04/T040.md) | desktop T134 | T164–T166 |
| UI-14 | Two-pane desktop/tablet Settings. | [T040](tasks/P04/T040.md), [T119B](tasks/P10/T119B.md) | iPad T157; desktop T134 | T163–T166 |
| UI-15 | Home menu-bar sharing service. | [T102](tasks/P09/T102.md) | iPhone T128 | T159D |
| UI-16 | Nerds: runtime, connection, analytics, services diagnostics. | [T155](tasks/P11/T155.md) | desktop T134 | T164–T166 |
| UI-17 | Select UI language or follow system locale. | [T119](tasks/P10/T119.md) | iPhone T128 | T159H |
| UI-18 | Declared accessibility: dark interface, non-color-only distinctions, contrast. | [T119](tasks/P10/T119.md) | iPhone T128 | T159H |
| UI-19 | Analytics dashboard. | [T118](tasks/P10/T118.md) | iPhone T128 | T159E |

## DA — Data, analytics and lock (9)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| DA-01 | Persistent local history, settings, Personas, server URLs | [T008](tasks/P01/T008.md), [T008A](tasks/P01/T008A.md), [T008B](tasks/P01/T008B.md) | iPhone T128 | T159F |
| DA-02 | Export one chat as PDF/TXT; all chats as ZIP | [T044](tasks/P04/T044.md) | iPhone T128 | T159F |
| DA-03 | Optional encrypted cloud backup | [T110](tasks/P10/T110.md) | iPhone T128 | T159E |
| DA-04 | Optional product analytics | [T118](tasks/P10/T118.md) | iPhone T128 | T159E |
| DA-05 | App Lock PIN | [T108](tasks/P10/T108.md) | iPhone T128 | T159E |
| DA-06 | Lock grace period | [T108](tasks/P10/T108.md) | iPhone T128 | T159E |
| DA-07 | Device-local salted PIN hash | [T108](tasks/P10/T108.md) | iPhone T128 | T159E |
| DA-08 | Biometric unlock and account-assisted PIN recovery | [T108](tasks/P10/T108.md), [T109](tasks/P10/T109.md) | iPhone T128 | T159E |
| DA-09 | Cold-start PIN challenge; PIN required to disable lock | [T108](tasks/P10/T108.md) | iPhone T128 | T159E |

## AC — Accounts, purchases and support (8)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| AC-01 | Anonymous account, optional Apple/Google/email linking | [T111](tasks/P10/T111.md) | iPhone T128 | T159E |
| AC-02 | Email password recovery | [T111](tasks/P10/T111.md) | iPhone T128 | T159E |
| AC-03 | Monthly, yearly, lifetime Pro; purchase restoration/activation guidance | [T112](tasks/P10/T112.md) | iPhone T128 | T159E |
| AC-04 | Apple Family Sharing | [T112](tasks/P10/T112.md) | iPhone T128 | T159E |
| AC-05 | In-app support and feature requests | [T113](tasks/P10/T113.md) | iPhone T128 | T159E |
| AC-06 | Support attachments; chat entry | [T113](tasks/P10/T113.md) | iPhone T128 | T159E |
| AC-07 | In-app changelog and update/version checks | [T113](tasks/P10/T113.md) | iPhone T128 | T159E |
| AC-08 | Community theme and voice catalogs | [T106](tasks/P10/T106.md) | iPhone T128 | T159E |

## AU — Automation (8)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| AU-01 | iOS Home Screen/Control Center widgets: new chat, camera, news where offered. | [T114](tasks/P10/T114.md), [T115](tasks/P10/T115.md) | iPhone T128 | T159D |
| AU-02 | Download Lock Screen/Dynamic Island progress; generation Live Activity. | [T114](tasks/P10/T114.md), [T115](tasks/P10/T115.md) | iPhone T128 | T159D |
| AU-03 | Siri, Action Button, Share Sheet, and scheduled Shortcuts entry points. | [T116](tasks/P10/T116.md), [T117A](tasks/P10/T117A.md) | iPhone T128 | T159D |
| AU-04 | App Intents: ask, search, voice chat, summarize, translate, news brief. | [T116](tasks/P10/T116.md) | iPhone T128 | T159D |
| AU-05 | lmmini://shortcut/... deep-link family. | [T116](tasks/P10/T116.md) | iPhone T128 | T159D |
| AU-06 | OCR-oriented screenshot and business-card workflows. | [T117D](tasks/P10/T117D.md), [T132](tasks/P11/T132.md) | iPhone T128 | T159D |
| AU-07 | Retain context between Shortcut runs through variables/files. | [T117G](tasks/P10/T117G.md) | iPhone T128 | T159D |
| AU-08 | Spoken search and news/weather brief workflows. | [T117F](tasks/P10/T117F.md) | iPhone T128 | T159D |

## UP — Later documented updates (8)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| UP-01 | Free local Unsloth Desktop compatible provider | [T020](tasks/P02/T020.md) | iPhone T128 | T159A |
| UP-02 | Generated-image gallery, including chat menu access | [T089](tasks/P08/T089.md), [T090](tasks/P08/T090.md) | iPhone T128 | T159C |
| UP-03 | ComfyUI generation queue | [T087](tasks/P08/T087.md) | iPhone T128 | T159C |
| UP-04 | Cancel Hugging Face/LM Studio downloads | [T034](tasks/P03/T034.md) | iPhone T128 | T159A |
| UP-05 | Reload prompt after changing context; linked image/chat server update prompts | [T034](tasks/P03/T034.md) | iPhone T128 | T159F, T159C |
| UP-06 | Face ID/Touch ID/fingerprint unlock; emailed PIN recovery link | [T108](tasks/P10/T108.md) | iPhone T128 | T159E |
| UP-07 | Compress an oversized attached image and resend | [T043](tasks/P04/T043.md) | iPhone T128 | T159F |
| UP-08 | Hide embedding models from chat-model selection | [T025](tasks/P02/T025.md) | iPhone T128 | T159A |

## ER — Errors and recovery (8)

| ID | Behavior | Implementation cards | Working milestone | Deep proof |
|---|---|---|---|---|
| ER-01 | Provider-specific connection guidance. | [T025](tasks/P02/T025.md) | iPhone T128 | T159A |
| ER-02 | Distinguish URL/token/network errors from model incompatibility. | [T025](tasks/P02/T025.md) | iPhone T128 | T159A |
| ER-03 | Show model/context/tool/voice/sync setup failures. | [T049](tasks/P04/T049.md) | iPhone T128 | T159A, T159C, T159D, T159G |
| ER-04 | Missing model banner with selection recovery. | [T049](tasks/P04/T049.md) | iPhone T128 | T159A |
| ER-05 | Report host termination and context/max-token causes. | [T049](tasks/P04/T049.md) | iPhone T128 | T159F, T159D |
| ER-06 | Identify unavailable image servers, missing checkpoints/workflows, and MCP failures. | [T092](tasks/P08/T092.md) | iPhone T128 | T159C, T159G |
| ER-07 | Recover sharing connection after host sleep. | [T103](tasks/P09/T103.md) | iPhone T128 | T159D |
| ER-08 | Cancel stopped-reply memory extraction. | [T052](tasks/P05/T052.md) | iPhone T128 | T159B |

## Reconciliation rule

T159A–H and T160–T169 write small evidence manifests with feature IDs and exact builds/devices/backends. T121 joins them against this table, and T127 rejects any missing row, placeholder-only implementation, hidden blocker or mislabeled fixture as live proof. New inventory rows need an implementation card, working milestone and deep shard before assignment.
