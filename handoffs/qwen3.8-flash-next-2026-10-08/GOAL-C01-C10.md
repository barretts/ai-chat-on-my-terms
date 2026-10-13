# LocalLab C01-C10 goal run

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../plans/POWERSHELL.md).

## Objective

Continue the existing LocalLab working tree at `C:\code\cht` through the approved C01-C10
priority queue: automatic web research, iOS dictation, and tools/MCP. The user selected
this scope on October 9, 2026. Arena remains held. Execute the approved work; do not
restart the project, replace the roadmap, or extend this goal into subsequent batches.

This is a goal for one coding agent. Keep working through ready cards rather than stopping
after the first card. Preserve all existing modified and untracked work, saved provider/model
identity, secret references, the existing appearance, and voice/file workflows.

## Procedure

1. Use PowerShell for all local commands. Read `plans/POWERSHELL.md` once and confirm the
   actual command runner. If a tool uses Bash, launch PowerShell explicitly as the guide says.
   Check `git status --short` once; an unrelated `.opencode/` entry needs no investigation.
2. Read these files once under `handoffs/qwen3.8-flash-next-2026-10-08/`:
   `START_HERE.md`, `CURRENT_STATE.md`, `TASK_QUEUE.md`, `PROGRESS.md`, and the relevant
   sections of `PLAN.md`. Current progress and source take precedence over older snapshots.
   Consult `plans/03-execution.md`, `plans/06-verification.md`, original task cards and
   `PARITY.md` only for the active card's contracts, dependencies or feature rows.
3. Resume the first unfinished dependency-ready card, currently C01 unless progress advances.
   C01 persistence, conversation overrides and the pure policy resolver already exist.
   Verify the recorded review fixes, then finish the panel controls and composer/screen wiring.
   Do not recreate completed parts. Direct offline requests, including "Do not look this up on
   the web" and "Never look it up on the internet", and per-turn off must veto both automatic
   tools and manual fetching. Quoted/code examples stay neutral.
4. Finish C01's acceptance checks before C02. Thereafter follow `TASK_QUEUE.md` through C10,
   one active card at a time. Read only that card's needed source, state the first concrete edit
   in at most three bullets, implement it using existing conventions, and run its focused checks.
   Use the existing local Vitest and TypeScript binaries; pnpm is absent from PATH.
5. Append concise results to `PROGRESS.md` after each completed part or card: changed paths,
   exact commands/results, feature IDs, fixture/live/native evidence level, remaining obligations,
   blockers, and the next ready action. Update other ledgers only for behavior actually delivered.
   A card can have implementation progress while native/service proof stays pending; retain that
   distinction and honor the actual dependency acceptance before starting its descendants.
6. Continue to the next ready card without asking for routine permission between cards.
   If a resource blocks one card, record it and select the next independent ready card.
   Do not run overlapping edits or spawn parallel workers. Keep context below roughly 48K
   per active card; checkpoint before compaction and resume from progress without repeating work.
7. At C10, run its integration checks, including the full mobile composition suite and touched
   package/mobile typechecks, with rendered phone fixtures and native/device evidence when
   available. Reopen the owning card for a failed integration requirement.

## Stopping Conditions

- Success requires C01-C10's applicable acceptance criteria and exact check results to be
  recorded, with required native/service proof collected. Stop and report at this checkpoint;
  do not start the subsequent roadmap batches.
- If only held or externally blocked obligations remain, write a precise blocker list, the
  resource/decision owner, the evidence still needed, and the resume action. Mark remaining
  work blocked/pending and wait for input; never call the goal complete or weaken acceptance.
- After two unsuccessful attempts at one approach, change approach. If still blocked, record
  the failed assumption and actual error, then continue only independent ready work.
- Do not stop simply because one card finishes or a turn/compaction ends. Conversely, a reached
  token/time limit or missing proof does not establish completion.

## Procedure Risks

Use model-native automatic web tools only when the actual selected-model tool capability is
`yes`. Models reporting `no` or `unknown` keep the explicit manual workflow. Add no extra
planning-model request and do not silently switch providers. Preserve cancellation, context
budgets, source/terminal event contracts, and host-bound secret references.

Do not build or activate Arena, discard/stash/reset existing work, stage unrelated files,
publish or deploy external artifacts, rewrite dependency pins, or claim fixtures as device proof.
Do not load all 231 feature rows or all task cards into one context. Accept an `rg` no-match
result and avoid repeated reads/searches; inspect an unchanged file again only for a specific
omitted section or to verify an edit.

## Evaluation

Run each active card's specified focused checks. C01 includes settings/intent/research and
composer cases plus mobile TypeScript; C02-C09 add their named package and integration cases;
C10 adds the full composition checkpoint. Use PowerShell commands and capture the exit code
for every native check. Record failures as well as passes; distinguish pre-existing failures.

Report completed and incomplete cards, changed paths, exact tests/typecheck results, evidence
paths, native/live proof still pending, and the next action. Confirm the condition that ended
the run. Goal mode itself is continuation, not evidence that any card passed.

## OMP launch command

Paste this in OMP while working in `C:\code\cht`:

```text
/goal set Continue LocalLab in C:/code/cht and finish the C01-C10 priority queue. Read and follow C:/code/cht/handoffs/qwen3.8-flash-next-2026-10-08/GOAL-C01-C10.md. Use PowerShell, preserve existing work, and keep Arena held.
```

The installed OMP exposes `/goal set <objective>` and goal mode is enabled by default.
If it reports disabled, enable Goal Mode in Settings > Tasks > Modes. An active/paused
plan mode or vibe mode must be exited before the goal command is accepted.
