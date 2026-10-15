# R009 — Mac MLX worker blocks its own inference tasks while reading stdin

- **Priority:** P1
- **Original tasks:** T030
- **Suggested owner:** T030 Mac MLX worker
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Read stdin on a dedicated blocking thread or feed commands through an asynchronous stream so the actor can execute generation and cancellation tasks.

## Evidence and failure scenario

**Source:** [workers/mlx-macos/Sources/LocalLabMlxWorker/main.swift:51](../../../workers/mlx-macos/Sources/LocalLabMlxWorker/main.swift#L51)

**Trigger:** Keep the worker stdin open and send a load or generate command, then wait for a result.

**Impact:** Worker.run is MainActor-isolated and calls synchronous readLine in a loop without suspending. The load/generation Task closures inherit that actor and cannot execute while the loop blocks waiting for another line. Normal persistent-worker inference never begins.

**Review evidence:** The Worker class is annotated @MainActor. run contains while let line = readLine(). The load/unload/generate cases create Task closures but do not await or yield. Both runtime work and completion events are inside those closures.

**Evidence limit:** Confirmed actor/control-flow defect by source inspection; Mac worker not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T030) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Move blocking stdin reads off MainActor or feed commands through an asynchronous command stream.
3. Keep load/generation/cancellation state serialized while allowing the actor to execute between commands. Handle EOF and shutdown explicitly.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] With stdin left open, one load/generate command produces completion without a second input line.
- [ ] Cancellation and EOF remain responsive during generation; no actor-isolated state is accessed unsafely.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
