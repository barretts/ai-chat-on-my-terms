# Remaining blocker implementation follow-up

Baseline: `5c558196e26389dc701d0e678930a754d048c411`, plus the existing uncommitted R014 parser/test changes. This document records working-tree implementation changes, not a new runtime acceptance review.

The user requested fixes starting with R014, then explicitly selected **fix code without running tests**. No test commands were run and no new test cases were added by this pass. Existing R014 test edits were preserved; existing protocol expectations/known-answer fixture consumers were adjusted for protocol 1.2.

## Implemented changes

| Finding | Implementation |
| --- | --- |
| R014 | Normalize LF/CRLF/CR incrementally, including split CRLF and trailing CR; limit complete and incomplete frames; cancel the owned reader on abort/early exit; propagate discovery cancellation to the legacy reader. |
| R018 | Treat a nonempty prompt_id as accepted ComfyUI work, preserving job tracking even when node_errors is an empty map or diagnostics accompany an accepted job. Missing IDs still fail explicitly. |
| R019 | Rewrite only checkpoint MODEL/CLIP outputs, preserve VAE/other slots, allocate unoccupied LoRA node IDs, and copy nodes before rewriting so the input graph is not mutated. |
| R025 | Parse/validate table snapshots before mutation, clear all staged tables before reinsertion, defer foreign-key checks within the transaction, and reject invalid references before commit. This avoids later parent deletions cascading through already-restored children and allows cyclic reference insertion. |
| R026 | Resolve bearer sessions, scope object keys to the verified owner, require a per-account Pro decision, and send device session credentials from the backup client. Missing auth/gate configuration fails closed. Upload size is bounded while reading. |
| R007 / CR001 | Use random 96-bit handshake nonces; retain counter-derived data nonces under ephemeral session keys. Rotate protocol/KDF labels to 1.2 and provide matching Rust handshake sealing/opening APIs. Regenerate the existing known-answer and chat-wire fixtures. |
| R007 / CR002 | Construct handshake channels and ephemeral material per connect attempt, clear old data channels, ignore events from abandoned sockets, and settle canceled connection attempts. |
| R006 / CR003 | Persist copy chunks in the preference vault before acknowledging them; hydrate on restart and retain progress on same-choice retries. Clear membership only when initial sync is completed. Coalesce concurrent initial-sync requests. |
| R006 / CR004 | Pass an explicit per-row ownership predicate into replacement; exclude unselected Personas/private memory from deletion. Direct cover callers default to the chat tier. |
| R008 / CR005 | Enable a five-second acknowledgement watchdog by default; count pending batches so an empty copy marker still awaits its acknowledgement. Settle the remote sync helper on failure/close, and invalidate stale watchdog generations on wake/re-arm. |

## Compiler and source checks actually completed

All returned exit code 0:

- `node node_modules/typescript/bin/tsc --noEmit -p packages/tools/mcp-http/tsconfig.json`
- `node node_modules/typescript/bin/tsc --noEmit -p packages/media/comfyui/tsconfig.json`
- `node node_modules/typescript/bin/tsc --noEmit -p packages/sync/core/composition/tsconfig.json`
- `node node_modules/typescript/bin/tsc --noEmit -p packages/remote/crypto/tsconfig.json`
- `node node_modules/typescript/bin/tsc --noEmit -p packages/remote/client/tsconfig.json`
- `node node_modules/typescript/bin/tsc --noEmit -p packages/remote/integration/tsconfig.json`
- `node node_modules/typescript/bin/tsc --noEmit -p apps/mobile/tsconfig.json`
- `node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module preserve --moduleResolution bundler --strict --skipLibCheck --esModuleInterop services/api/features/backup/index.ts`
- `cargo check --lib --locked --offline --manifest-path apps/companion/Cargo.toml`
- `git diff --check`

The existing fixture generators ran to update protocol artifacts; generator success is not independent interoperability verification. The TypeScript compiler reads included test sources but does not execute tests. Rust `cargo check --lib` does not run tests or establish device behavior.

## Integration requirements and remaining verification

- Both pairing peers must use protocol 1.2. Rust hosts must use `seal_handshake_bytes` and `OpeningChannel::new_handshake` for handshake frames; data channels retain `seal_bytes`/`OpeningChannel::new`. Old peers require an update; re-pair if stored protocol state is incompatible.
- Backup route registration must supply the real auth store and an account-aware Pro gate: `registerBackupRoutes(app, store, gate, auth)`. The gate receives the authenticated user ID. Unconfigured registration rejects requests instead of opening shared storage. Existing unscoped objects are not exposed or automatically assigned to a guessed owner.
- Existing backup HTTP fixtures that assume anonymous upload/download need authenticated fixtures when testing is next authorized; they are not evidence of the new access-control behavior.
- Copy recovery relies on the host honoring the existing durable preference-vault contract. Snapshot membership is saved before acknowledgement; a failed vault write prevents acknowledgement.
- Functional SSE boundaries/cancellation, real ComfyUI acceptance/graphs, actual SQLite restore/rollback, cross-account backup denial, reconnect/crypto interoperability and process-restart recovery remain runtime-unverified because tests were explicitly excluded.
- Build 16 predates these fixes. The user subsequently authorized committing this implementation and deploying iOS preview build 17 without running tests. Build outcome will be recorded separately; this implementation record does not establish deployment success.
