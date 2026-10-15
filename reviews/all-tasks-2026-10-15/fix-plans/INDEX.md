# Review fix plans — 2026-10-15

28 separate task plans covering all 28 P1 findings in the [review CSV](../code-review-findings.csv). One Markdown file is one fix assignment. These are plans, not completed fixes.

## Baseline and scope

The review was source-only at HEAD `49e9d85750184b0ce07d1d927211f73a3bdfb533` with uncommitted implementation changes; [source-audit.json](../source-audit.json) records reviewed file hashes. Re-read the current code before acting. Original task IDs are traceability, not dependencies or proof of native completion. The previous review's T100 in-progress language is historical; assess its current implementation. No product tests, builds or fixes were performed while writing these plans.

## Recommended order

1. Restore install/build readiness: **R002 → R001**, then **R010**, **R017**, **R020**.
2. Remove app-wide stalls/lockout: **R003**, **R004**, **R024**, **R015**, **R009**, **R027**.
3. Protect sync correctness: **R023 → R008 → R006 → R016**; **R022** can be addressed separately.
4. Correct the remote protocol: **R007** and **R021**, then **R028**. Coordinate any protocol migration across these fixes.
5. Restore remaining feature paths: **R005**, **R011**, **R012**, **R013**, **R014**, **R018**, **R019**.
6. Complete backup correctness and access control: **R025**, **R026**. These can be prioritized earlier if backup is exposed.

All findings are P1; order reflects dependencies and integration efficiency, not a severity downgrade.

## Shared-file coordination

- R001/R002/R020 share workspace and lockfile concerns. Complete workspace discovery first and integrate lockfile edits together.
- R003/R004 share the queued database transaction contract; keep transaction semantics consistent.
- R006/R008/R016/R023 share sync composition and transport behavior. Avoid concurrent edits to these files; verify the combined state transitions.
- R007/R021/R028 span TypeScript/Rust crypto and protocol compatibility. Never reset counters or weaken replay checks as a workaround.
- R013/R014/R015 share MCP HTTP discovery/stream lifecycle. Integrate framing, cancellation and legacy dispatcher changes together.
- R018/R019 share the ComfyUI adapter. R025/R026 share backup integration but have independent root causes.

## Parts

| Part | Fix task | Prerequisites |
| --- | --- | --- |
| R001 | [Mobile startup imports depend on undeclared workspace packages](./R001-mobile-startup-imports-depend-on-undeclared-workspace-packages.md) | R002 |
| R002 | [Sync core packages are excluded from the workspace](./R002-sync-core-packages-are-excluded-from-the-workspace.md) | — |
| R003 | [Saving a group deadlocks the app database queue](./R003-saving-a-group-deadlocks-the-app-database-queue.md) | — |
| R004 | [Resetting Persona memory scope deadlocks the app database](./R004-resetting-persona-memory-scope-deadlocks-the-app-database.md) | — |
| R005 | [Voice Studio reads a nonexistent audio_uri column](./R005-voice-studio-reads-a-nonexistent-audio-uri-column.md) | — |
| R006 | [Initial copy tombstones the source records it must retain](./R006-initial-copy-tombstones-the-source-records-it-must-retain.md) | R008, R023 |
| R007 | [Recreating a saved pairing reuses encryption keys and nonces](./R007-recreating-a-saved-pairing-reuses-encryption-keys-and-nonces.md) | — |
| R008 | [Asynchronous acknowledgements leave later sync batches unsent](./R008-asynchronous-acknowledgements-leave-later-sync-batches-unsent.md) | R023 |
| R009 | [Mac MLX worker blocks its own inference tasks while reading stdin](./R009-mac-mlx-worker-blocks-its-own-inference-tasks-while-reading-stdin.md) | — |
| R010 | [Native download pause method has an incompatible Swift return type](./R010-native-download-pause-method-has-an-incompatible-swift-return-type.md) | — |
| R011 | [Cloud adapters discard the tool results required by the next tool round](./R011-cloud-adapters-discard-the-tool-results-required-by-the-next-tool-round.md) | — |
| R012 | [Hugging Face enqueue API rejects its declared revision argument](./R012-hugging-face-enqueue-api-rejects-its-declared-revision-argument.md) | — |
| R013 | [Legacy MCP SSE transport waits for replies on the wrong channel](./R013-legacy-mcp-sse-transport-waits-for-replies-on-the-wrong-channel.md) | — |
| R014 | [MCP SSE parser never recognizes CRLF message boundaries](./R014-mcp-sse-parser-never-recognizes-crlf-message-boundaries.md) | — |
| R015 | [MCP discovery escapes the chat setup deadline and can lock sending indefinitely](./R015-mcp-discovery-escapes-the-chat-setup-deadline-and-can-lock-sending-indefinitely.md) | — |
| R016 | [Initial Persona photo sync rejects the batch before its Persona arrives](./R016-initial-persona-photo-sync-rejects-the-batch-before-its-persona-arrives.md) | R006 |
| R017 | [Autolinked iOS speech module contains Swift compilation errors](./R017-autolinked-ios-speech-module-contains-swift-compilation-errors.md) | — |
| R018 | [ComfyUI rejects successful prompt submissions with empty node_errors](./R018-comfyui-rejects-successful-prompt-submissions-with-empty-node-errors.md) | — |
| R019 | [Applying LoRA rewires the default graph VAE to a CLIP output](./R019-applying-lora-rewires-the-default-graph-vae-to-a-clip-output.md) | — |
| R020 | [Relay Docker deployment cannot install the pnpm workspace](./R020-relay-docker-deployment-cannot-install-the-pnpm-workspace.md) | R002 |
| R021 | [Out-of-order encrypted frames remain replayable after acceptance](./R021-out-of-order-encrypted-frames-remain-replayable-after-acceptance.md) | — |
| R022 | [iCloud upload completion can discard newer pending edits](./R022-icloud-upload-completion-can-discard-newer-pending-edits.md) | — |
| R023 | [Acknowledgements of old sync records suppress later updates with the same identity](./R023-acknowledgements-of-old-sync-records-suppress-later-updates-with-the-same-identity.md) | — |
| R024 | [App Lock permanently gates sessions that have no PIN configured](./R024-app-lock-permanently-gates-sessions-that-have-no-pin-configured.md) | — |
| R025 | [Backup restore inserts child tables before their parents](./R025-backup-restore-inserts-child-tables-before-their-parents.md) | — |
| R026 | [Backup object routes allow cross-user overwrite and deletion](./R026-backup-object-routes-allow-cross-user-overwrite-and-deletion.md) | — |
| R027 | [Configured service providers create an endless refresh loop](./R027-configured-service-providers-create-an-endless-refresh-loop.md) | — |
| R028 | [Mobile and Rust companion cannot exchange remote chat messages](./R028-mobile-and-rust-companion-cannot-exchange-remote-chat-messages.md) | R007, R021 |

## Agent completion report

For each assigned part, report the finding ID, current reproduction/counterevidence, files changed, acceptance checks actually completed and remaining verification gaps. Never label an unrun native or cross-language check as passed. Keep unrelated code and review evidence intact.
