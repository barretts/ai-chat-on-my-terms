# Frozen contracts for parallel implementation

T002 publishes these TypeScript types, matching Zod schemas and fixture JSON before feature branches begin. Shared exports are subpath imports; only T002 changes a published type after a coordinator-approved migration. Do not import a feature's concrete implementation from another feature package.

## Identity and storage rules

Every entity has id (UUIDv7), createdAt, updatedAt and revision. revision is a hybrid logical clock tuple (wallMs, counter, deviceId); ties compare deviceId. IDs are assigned before enqueue. Local records are not rewritten to new IDs during sync/import. Tombstones have the same identity and revision. Secrets are secure-store references; raw tokens, PIN, pairing secrets and provider headers are never message fields, backups or logs.

Core persisted records: ProviderConnection (kind, host, credential/header refs); ModelRecord (backend ID, runtime, format/quant/capabilities); ModelFile (hash, managed path and job state); ParameterPreset (scope, explicitly set keys); Conversation (kind, folder, binding, overrides, revision); Message (speaker, ordered parts, selected variant, run status); ResponseVariant (generation and selection); Attachment (MIME/hash/blob ref/extracted text); Folder; Persona; MemoryEntry with provenance/scope; GroupRoom and GroupParticipant; ToolServer and ToolInvocation; VoiceProfile; MediaWorkflow and MediaJob; ArenaRun and Contestant; PairedDevice; SyncRecord/Tombstone; Preference and consent entries. T003 owns migration source and version allocator.

Message parts use a tagged union: text, reasoning, image, file, audio, generated-media, tool-call, tool-result, source and error. Each part retains message/run/participant identity where relevant. A rendered string cannot be the sole persisted source of tool or reasoning truth.

## Ports and run events

ProviderPort:
- listModels(connection), getCapabilities(connection, model), startRun(RunRequest, signal): AsyncIterable<RunEvent>
- Optional ModelManagerPort: list/download/cancel/load/unload/status. An unsupported operation is a typed unsupported result.

RunRequest contains runId, conversationId, messageId, providerConnectionId, modelId, ordered context parts, effective parameters, permitted tools, attachment refs and an explicit reasoning/JSON preference. Connection credentials resolve inside adapter, never in RunRequest fixtures.

RunEvent union: RunStarted, LoadProgress, PromptProgress, ReasoningDelta, TextDelta, ToolCall, ToolResult, Source, Usage, MediaReference, RunCompleted, RunCanceled, RunFailed. Every event has runId, sequence, timestamp and optional participantId. sequence is strictly increasing per run; terminal events occur once. Projection ignores duplicate sequence and does not mistake provider token order for wall-clock order across concurrent runs.

Other frozen ports: ConversationRepository, BlobStore, SecretStore, DownloadPort, InferencePort, ToolPort, SpeechInputPort, SpeechOutputPort, MediaPort, PairingPort, SyncTransport, NotificationPort, CapabilityResolver, EntitlementPort and AnalyticsPort. All expose cancel/dispose when they own work. Async methods report typed errors (offline, unauthorized, permission, unsupported, missing-model, context-full, quota, timeout, host-stopped, malformed, canceled) with recoverable metadata and backend identity. The UI never parses provider error strings.

## Pairing and service wire shapes

Project pairing QR v1 includes protocol major/minor, companion route ID, public relay URL, random mobile route ticket, generated 256-bit pairing secret and server identity fingerprint; the relay never receives the pairing secret. Companion registers a hashed route ticket and retains its own auth credential. Peer hello proves possession of the secret, exchanges fresh session salt/nonces and binds protocol version, route and roles into HKDF-SHA256-derived directional AES-256-GCM keys. Counters/nonce space are per session and direction; receiver rejects duplicate/out-of-window counters. Key rotation revokes the old route. The relay sees only opaque framed ciphertext with routing, bounded byte length and expiry metadata. T093 freezes golden vectors shared by TypeScript and Rust.

Encrypted payload tags: request, event, cancel, binary-start/chunk/end, sync-batch/ack, health, close. Each frame has protocol version, route ID, request ID, frame sequence, content tag and bounded declared size; media chunks include MIME, length and hash and are reassembled with byte-level verification. Server route allowlist permits configured local model/image/audio hosts only.

Optional service endpoints are versioned under /v1: account/auth delegated to Better Auth; /search, /sandbox/jobs, /catalog/themes, /support, /backup/objects, /entitlements, /metrics and /release/version. T007 publishes OpenAPI/Zod schemas, auth/entitlement requirements and fixtures. API keys and chat bodies are absent from routine telemetry.

Automation deep links use the project-owned `locallab://shortcut/...` scheme with typed, size-bounded payloads and explicit permission checks. T116 owns the route registry; unrelated schemes are rejected.

## Sync and data precedence

Initial pair presents three choices: copy phone, copy Mac, merge. Thereafter opted-in messages/folders/deletes sync bidirectionally. Higher revision wins; tombstones beat equal-revision updates. Asset transfer is content-addressed and acked. Disabling sync retains both local copies. Selective Persona sync includes selected profile/photo/allowed memories only; absent local provider, voice and workflow references are unresolved explicitly. Settings, themes, API keys, downloaded models, voice packs, PIN and image workflows do not sync through the Home-style channel. iCloud uses the same entity/tombstone model but its own transport and opt-in state. No automatic iCloud/relay echo loop is permitted.
