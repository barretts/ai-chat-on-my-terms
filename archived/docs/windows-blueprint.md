# Windows implementation blueprint

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../plans/POWERSHELL.md).

This is a proposed design for your learning project, not a description of LM Mini's internal code. The [feature inventory](../../docs/lm-mini-features.md) is the source of parity requirements. The stages below change implementation order, not the final scope.

## Product shape

Build a Windows desktop application with a local database, interchangeable provider adapters, and optional worker processes. Keep the interface usable with one configured backend while allowing every advanced feature to be added through a clear module boundary.

For a Windows-only project, **C# with modern .NET and WPF** is a reasonable starting choice: XAML separates presentation from application logic, and WPF provides data binding, styling, desktop controls, and document/media facilities. This is my recommendation for readable Windows code, not evidence of LM Mini's stack. [Microsoft WPF overview](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/)

Use a local SQLite database as a design choice, with attachment files in an app-managed directory. Start with existing local servers, then add a managed GGUF worker for self-contained inference. llama.cpp offers local inference, downloadable binaries, and a compatible server, making it a candidate for that worker. Pin and test a particular release before distributing it. [llama.cpp repository](https://github.com/ggml-org/llama.cpp)

## Windows adaptation map

| Original platform capability | Proposed Windows equivalent | Inventory coverage |
| --- | --- | --- |
| Desktop Home interface | Windows title bar, navigation rail, conversation columns | UI-11–UI-16 |
| Mac menu bar companion | System tray with explicit quit/startup controls | RE-07, UI-15 |
| Command-number navigation | Ctrl-number navigation | UI-13 |
| MLX execution | GGUF worker locally; preserve remote Apple-server adapter | PR-01–PR-02, PR-06 |
| Core ML image execution | Locally managed Windows image worker or local ComfyUI/A1111 | IM-03–IM-11 |
| System speech | Windows speech adapter plus independent local STT worker | VO-01, VO-07–VO-09 |
| iOS call surface | Persistent desktop voice session with device selection | VO-11–VO-12 |
| Siri/App Intents | CLI and registered URL protocol entry points | AU-03–AU-05 |
| Action Button/Share Sheet | Keyboard shortcut and clipboard/file commands | AU-03, AU-06 |
| Dynamic Island/Live Activity | Windows notification and tray/taskbar progress | AU-01–AU-02 |
| iCloud | Optional independently designed encrypted sync/backup service | SY-09, DA-03 |
| Biometric app unlock | Windows biometric adapter, retaining PIN fallback | DA-05–DA-08 |
| Apple/Google purchases | Separate optional entitlement service | AC-03–AC-04 |
| Apple Pencil behavior | Pen-aware scrolling/selection on touch Windows devices | UI-09 |
| iPhone USB transport | Separate transport investigation; retain it in full scope | RE-11 |

These are functional equivalents. They do not imply that Apple's OS integrations can execute on Windows. Phone compatibility with official LM Mini is also a separate requirement: public feature descriptions do not establish a supported third-party pairing or sync protocol.

## Screen map

| Screen | Proposed contents | Main feature IDs |
| --- | --- | --- |
| Welcome | Skill level, connection path, hardware fit, download, theme, optional race | OB-* |
| Chats | Conversation/folder list, retrieval, individual or group creation | CH-04–CH-06, AT-07–AT-08 |
| Conversation | Transcript, composer, model chip, context, settings, tool/media activity | CH-*, AT-*, TL-*, IM-* |
| Chat menu | Export, gallery, appearance, parameter overrides | DA-02, UP-02, CH-07–CH-08 |
| Personas | Library, profile editor, generator, scoped facts, workflow/voice bindings | PE-*, ME-* |
| Group setup | Cast, model bindings, room rules, scenario, voice and tools | GR-* |
| Arena | Contestants, run controls, output panels, metrics, history | AR-* |
| Models | Catalog, local/server inventory, downloads, load controls, presets | MO-*, PA-* |
| Voice | Engines, packs, transcription, output settings, conversation controls | VO-* |
| Images | Servers, checkpoints, workflows, settings, gallery, queue | IM-*, UP-02–UP-03 |
| Share with phone | Pairing, connection state, routes, keys, sync options | RE-*, SY-* |
| Settings | Appearance, language, providers, tools, data, privacy, account | UI-*, PR-*, TL-*, DA-*, AC-* |
| Diagnostics | Redacted runtime state, worker health, timings, actionable failures | UI-16, ER-* |
| Support | Requests, votes, replies, attachments, release notes | AC-05–AC-07 |

## Module boundaries

```text
Desktop UI and view models
            |
Application services
  conversations / context / parameters / groups / Arena
  Personas / memory / search / downloads / export
            |
Interfaces
  model providers / tool execution / speech / images
  secrets / persistence / notifications / pairing / sync
            |
Adapters
  LM Studio / Ollama / compatible servers / cloud providers
  GGUF worker / speech workers / ComfyUI / A1111 / MCP
  SQLite / local files / Windows services / optional relay
```

Keep provider responses out of view models. Normalize output into events such as `LoadProgress`, `ReasoningDelta`, `TextDelta`, `ToolStarted`, `ToolCompleted`, `Usage`, `Completed`, and `Failed`. Each run has a cancellation token, stable ID, and terminal state. Download and media jobs have their own lifecycles.

Use a capability object per connection/model: vision, tools, reasoning control, JSON output, server-managed state, sampling fields, and model lifecycle operations. Derive the active UI and request fields from that object. A model must not silently switch providers when a group binding fails.

## Provider implementation notes

LM Studio's native v1 API provides stateful chat, model management, and MCP integration. Its compatible chat-completions route is a different API with different capabilities. Preserve that distinction in the adapter instead of assuming every compatible endpoint supports management or server-hosted MCP. The native routes currently include `/api/v1/chat`, `/api/v1/models`, and model load/unload/download/status operations. [LM Studio API](https://lmstudio.ai/docs/developer/rest)

Ollama's local API base is `http://localhost:11434/api`; its compatible base is `http://localhost:11434/v1`. Use the local adapter for management operations and record the actual configured host. [Ollama API introduction](https://docs.ollama.com/api/introduction). Its streaming responses use newline-delimited JSON, so give that transport its own incremental parser. [Ollama streaming](https://docs.ollama.com/api/streaming)

For direct MCP support, negotiate the protocol and transport explicitly. The referenced specification defines stdio and Streamable HTTP; legacy HTTP+SSE is a separate compatibility path. This is an implementation option for your client, not a claim that LM Mini directly implements every transport. [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Treat secrets as references to a protected store rather than plain fields in exported configuration. Resolve headers only when sending a request to their configured host. Treat tool invocations as structured operations; a chat model should not receive unrestricted Windows shell access as a substitute for the advertised sandbox.

## Proposed persistent entities

| Entity | Important fields / relationships |
| --- | --- |
| ProviderConnection | ID, kind, display name, URL, secret references, capability snapshot |
| ModelRecord | Provider ID, backend model ID, format/quant, capabilities, lifecycle state |
| ModelFile | Catalog reference, local path, size/hash, download job ID |
| ParameterPreset | Scope, owner ID, explicitly set fields; unset differs from zero/false |
| Conversation | ID, title, folder ID, kind, selected binding, overrides, revision |
| Message | ID, conversation ID, speaker ID, content, reasoning, run state, timestamp |
| ResponseVariant | Source message/run ID, revision, selection state; preserve alternatives |
| Attachment | Message ID, managed path, MIME type, extracted text, dimensions |
| Folder | ID, name, color, cover reference, revision |
| Persona | ID, prompt, avatar, binding, voice, preset, memory policy, workflow ID |
| MemoryEntry | ID, fact, source IDs, visibility, Persona associations, revision |
| GroupRoom | Conversation ID, scenario, user name, turn policy, scheduling options |
| GroupParticipant | Room ID, Persona/binding, role prompt, appearance, tools, voice |
| ToolServer | ID, transport, endpoint/name, auth references, enabled state |
| ToolInvocation | Run ID, message/participant ID, arguments/result, duration, status |
| VoiceProfile | Provider, speaker, language, rate/pitch, key/pack references |
| MediaWorkflow | Backend, API graph, placeholder mappings, Persona associations |
| MediaJob | Conversation ID, workflow/settings snapshot, status, output references |
| ArenaRun / Contestant | Input/settings snapshot, bindings, timings, usage, output |
| PairedDevice | ID, transport, key reference, permission scope, connection state |
| SyncRecord / Tombstone | Entity ID, revision, deletion marker, peer acknowledgments |
| Preferences | UI/locale, defaults, consent, local lock policy |

This schema is a proposal. It is not reverse engineered from LM Mini. Store binary assets outside the main message rows and retain stable references. A PIN gate is separate from database encryption; decide explicitly whether your learning app encrypts its local database.

## Critical flows to make readable in code

1. **Send a message:** resolve provider and effective settings; check capabilities; assemble permitted facts and attachments; fit context; persist pending turn; stream normalized events; persist terminal state; schedule title/memory/sync work only if appropriate.
2. **Regenerate:** retain the prior variant; select the correct original binding; rebuild input without injecting obsolete generated answers; stream a new variant; make the selected variant explicit.
3. **Group turn:** resolve eligible participants; freeze the relevant transcript snapshot; schedule serial or concurrent runs; preserve speaker/run identity; queue speech separately from text completion.
4. **Tool loop:** collect enabled schemas; accept structured calls; route results back to the same run; show transcript activity; honor cancellation and budgets; report a missing terminal answer.
5. **Media generation:** snapshot settings; validate required graph inputs; fill typed placeholders; enqueue; follow progress; save output before marking complete; surface generation/server failures.
6. **Synchronization:** perform initial reconciliation; show what will copy/merge; apply revision/conflict policy; propagate deletion markers; retain copies when disabled; reconnect without duplicating records.
7. **Voice conversation:** distinguish listening, transcription, generation, playback, and idle; release capture before playback; restart listening only when the session remains active.

These flow steps are proposed engineering behavior. Source parity remains attached to feature IDs, not these internal algorithms.

## Implementation sequence and verification

| Stage | Complete this part of the full scope | Acceptance evidence |
| --- | --- | --- |
| 1 | Shell, onboarding, PR-03/PR-04/PR-08, core CH/PA/DA-01 | Connect two independent backends; stream, stop, restart, and reopen persisted threads; show correct effective settings. |
| 2 | Remaining chat, attachments, folders, retrieval, export/import | Round-trip supported content; reopen attachments; preserve variants; test all context policies on an actually small window. |
| 3 | MO lifecycle, PR-01 local worker, remaining providers | Download/cancel/import/load/unload; chat with network disconnected; exercise supported and unsupported parameter controls. |
| 4 | PE and ME | Distinct role bindings persist; private facts do not enter unrelated prompts; canceled generation does not extract facts. |
| 5 | GR and AR | Same-role/different-model and same-model/different-role cases; serial/manual/parallel scheduling; accurate run labels and timing boundaries. |
| 6 | TL | Real multi-step search/MCP loop; auth and tool failure cases; no tools sent when disabled or unsupported. |
| 7 | VO | Local STT/TTS cycle, distinct speaker settings, no self-transcription of playback, clean stop/restart and device failures. |
| 8 | IM and media UP additions | A1111 and ComfyUI workflows, parameter substitution, LoRAs, queue/gallery persistence, video path verification, local image execution equivalent. |
| 9 | RE and SY | Own encrypted relay/peer implementation; pairing/revocation, remote streaming and binaries, merge/delete/reconnect tests; separate USB investigation. |
| 10 | UI, AU, security, backup, AC, remaining ER | Theme persistence, desktop automation equivalents, local lock/recovery policy, encrypted restore, account/community services, localization/accessibility audit. |

Stages 9–10 need independently implemented services or documented adapters; they cannot be satisfied by empty toggles. During development, visibly label unavailable modules so a reader can distinguish a working feature from a planned one. Keep a traceable checklist for every inventory ID and each grouped subcontrol.

## Decisions still needed before claiming parity

Resolve the installed-app questions in [research notes](research-notes.md). Record the target LM Mini version and which Windows equivalents count as accepted substitutions. In particular, distinguish “same functionality in our own ecosystem” from “connects to official LM Mini mobile clients.” The latter requires protocol evidence that the public pages do not provide.
