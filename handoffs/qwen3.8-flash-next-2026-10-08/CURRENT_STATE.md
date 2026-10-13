# Current state — October 8, 2026

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../plans/POWERSHELL.md).

## Reliable resume point

- Project: LocalLab. Repository root: C:/code/cht.
- Git HEAD: 23b83afa94e7301267d53e30e4d853edb9553acb.
- Git history has an initial import and a speech-patch lockfile fix. It does not capture all subsequent feature work.
- Latest recorded native preview: iPhone build 14, EAS ID 2959c28e-fc71-453c-8295-a32d15656eac.
- Build finished September 29, 2026 at 18:51:44.277 UTC.
- All 856 files in the saved build-14 source manifest matched the working tree during this audit.
- Before creating this handoff, git status had 152 entries: 94 tracked changes and 58 untracked entries. Those entries include directories; there were 72 individual untracked files.
- The user reports that the last deployment installed on their phone works well. The exact installed build was not independently read from the phone.
- Build receipts recorded physicalIphoneTested=false at packaging time. This historical flag does not negate the user's later general phone feedback, but neither supplies a feature-by-feature device matrix.

## Fresh checks performed in this conversation

Both succeeded using existing dependencies, without changing application source:

```powershell
node .\node_modules\typescript\bin\tsc --noEmit -p .\apps\mobile\tsconfig.json
node .\node_modules\vitest\vitest.mjs run --root C:/code/cht apps/mobile/composition
```

Mobile TypeScript exited 0. Composition: 24 files, 206 tests passed.
git diff --check also exited successfully before handoff creation.

The documented pnpm runner failed because pnpm is currently absent from PATH. Current Node is 26.8.2. The project pins pnpm 8.15.9; EAS preview pins Node 24.13.1. Do not change package versions or rewrite the lockfile just to repair command lookup. Use existing local binaries for checks where possible; restore the pinned package manager when dependency work requires it.

## Already built: preserve and extend

- Streaming chat, cancellation, response variants/regeneration, saved history, Markdown/code copying and recovery.
- Saved connection CRUD/favorites, real endpoint model catalogs, exact provider selection, host-bound secrets and scoped headers.
- Curated Qwen3.5 phone model downloads, cancellation, size/header checks, selection and removal. Native GGUF path is wired; per-model phone speed/thermal proof remains separate.
- Kokoro Heart/Bella and Piper Linda TTS, downloaded packs, reading responses, Stop, persisted rate and Persona voice/rate bindings.
- Conversation/folder library, local text search, attachments, chat import/export and ZIP archives.
- Persona profiles/avatars/prompts and managed, sourced memory with consent and extraction cancellation.
- Global/model/Persona/chat parameter scopes and automatic server-context detection, with explicit overrides.
- DuckDuckGo/Jina retrieval and optional Brave Search, citations and recoverable retrieval errors.
- Per-conversation Markdown/text workspace files, revision-safe edits, ZIP backup, native workspace functions on verified NInfer, and completed-response fallback for other models.
- Detailed recoverable errors, copy/export of sanitized local traces, compact phone panels and retro messenger layout.

These are source and scoped evidence observations, not a claim that every original feature or provider has passed native verification.

## Important stale statements

[September 27 feature status](../../docs/feature-status-2026-09-27.md) and plans/status stop before later work. Do not repeat their claims that web search is unavailable, Persona local voice bindings are wholly absent, or build 3 is the latest artifact.

Read these newer guides for the implemented contracts:

- [Web research](../../docs/web-research.md).
- [Chat workspace files](../../docs/chat-workspace-files.md).
- [Context and diagnostics](../../docs/troubleshooting.md).
- [Collapsible layout](../../docs/collapsible-layout.md).

Current research is triggered by explicit natural-language commands, supplied links or manual switches. Its "automatic" tests cover recognizing those requests, not autonomous model decisions. The new requirement is genuine model-native autonomous research.

## Existing foundations that are not complete app features

- Arena race engine and SQLite persistence exist; Arena UI is absent and now held.
- Tool registry, bounded loop and durable invocation store exist; workspace functions already use them. General tool settings and external MCP clients remain unfinished.
- Semantic indexing and embedding interfaces exist; a usable real local embedding runtime is not mounted.
- Managed import, native download and MLX adapters/workers have code; usable runtime/UI integration and native proof are incomplete.
- Desktop client is a scaffold. Companion executable and optional service entry point chiefly expose health endpoints. Workers/contracts do not establish finished remote routes, pairing or sync.
- Speech UI currently provides neural TTS. Dictation, Whisper and continuous voice are not delivered.

## Evidence pointers

These ignored local artifacts may be absent in a clone. This folder contains a compact durable summary in [baseline.json](evidence/baseline.json).

- tmp/iphone-build14/status.json
- tmp/iphone-build14/source-metadata.json
- tmp/iphone-build14/source-manifest.json
- tmp/iphone-build14/bundle-verification.json
- tmp/iphone-build14/artifact-verification.json

Build metadata records contextual counts, not fresh checks: 52 automatic-context, 96 workspace, 37 web-research, 7 archive, 35 compatible-local, 21 cloud-compatible and 28 tool-engine tests; Expo Doctor 21/21. Do not present those as re-run today.
