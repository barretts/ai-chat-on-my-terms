# Start here: LocalLab continuation for Qwen

Target model supplied by the user: Qwen3.8-Flash-Next q3 with 128K context.
Prepared October 8, 2026. Run your coding agent from C:/code/cht.

## Launch prompt

Paste the following into your Qwen coding agent:

> Continue LocalLab in the current C:/code/cht workspace. Read handoffs/qwen3.8-flash-next-2026-10-08/START_HERE.md, CURRENT_STATE.md, TASK_QUEUE.md and PROGRESS.md. Follow PLAN.md and the active task card. Start with C01 unless progress records a later task. Implement the next ready card, run its focused checks, and update PROGRESS.md with changed paths, exact results and the next action. Preserve existing uncommitted work. Automatic web research, iOS dictation and tools/MCP are the priorities. Arena is held by the user: do not build or activate it. Use model-native automatic web tools only when the selected model confirms tool support; do not add an extra planning call for other models. Do not restart the whole project or re-plan all 231 features.

## Read in this order

1. [Current state](CURRENT_STATE.md), [progress](PROGRESS.md), and [queue](TASK_QUEUE.md).
2. The active card under tasks/ and just the source files it names.
3. [Approved continuation plan](PLAN.md) once per fresh session.
4. Relevant original cards and feature rows from [the ledger](../../plans/05-coverage.md).
5. [Architecture](../../plans/01-architecture.md) and [contracts](../../plans/02-contracts.md) when touching a boundary.

Do not load every original task card, all transcripts, node_modules, or the entire large chat screen into context. Use rg and targeted source ranges. Refer to PARITY.md only for the active feature or the next batch.

## Operating rules

- The current working tree, including modified and untracked files, is the baseline. A clean checkout of HEAD omits work included in the phone deployment.
- Do not reset, clean, stash, discard, stage all files, or replace the existing working tree. Do not commit unrelated changes.
- Keep one active task at a time. Touch shared composition only for the active task's integration. Do not launch parallel agents unless separately requested.
- Aim for at most 12K tokens of initial reading and 48K total working context per card. Checkpoint before approaching that limit; a fresh session resumes from PROGRESS.md.
- Preserve saved provider/model identity. Do not silently choose another endpoint or model.
- Preserve the retro messenger appearance, current phone sheets, keyboard handling, selected voices, speed and Persona preferences.
- Keep credentials as host-bound SecretStore references. Never place keys, raw headers, PINs, pairing secrets or private request bodies in handoff documents or logs.
- Keep current no-large-weight-hashing behavior. Catalog digests are publisher identity metadata, not measured file hashes.
- Code, app integration, fixture checks, browser checks, native compilation and physical-device proof are separate evidence levels.
- An unavailable native toolchain or paid service leaves its proof pending; continue independent ready work.
- Do not claim T128, T159, T070, T083 or final parity complete based on a partial continuation checkpoint.
- Arena stays held until the user resumes it. Do not let its held aggregate gates block independent voice or tool implementation.

## Checkpoint format

Task ID; changed paths; behavior delivered; exact commands/results; original feature IDs;
evidence level; remaining device/service proof; defects/blockers; next task; necessary source ranges.

Record concise facts in PROGRESS.md. Do not paste large logs, credentials, or user conversations.
