# Rules for 64k-context workers and parallel coordination

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](POWERSHELL.md).

## Implement first, verify deeply second

An implementation card delivers working code through its frozen port and a **small functional/contract smoke check**. It does not wait for every paid vendor, physical OS variant, signing certificate or exhaustive failure scenario. Record those as named later verification work. T158 is the earliest real-model offline and configured OpenAI remote iPhone run; a Responses-compatible network fixture can provide bounded remote smoke when no live key is available, labeled as fixture evidence. T128 is the complete working iPhone build. T122/T123/T159A–H then run deep iPhone device/service/performance/security checks, including live OpenAI proof. T157, T129–T132 and T134 are later working platform builds; T160–T169 verify their OS/backend differences. T159 and T135 are release gates, never synonyms for T128.

## Per-card context and ownership

Read this README, architecture/contracts once per fresh context, the card, direct dependency handoffs, referenced inventory rows and relevant source only. Budget under 12k tokens for reads, 24k implementation, 12k checks/review and 2k handoff; reserve 14k for debugging. If the task cannot fit under 48k total, split it before coding into disjoint owned subpaths. Implementation can use fake ports until siblings merge; a fake must be labeled fixture evidence.

Every card states dependencies, owned paths, feature IDs, steps and the check level. Only its active owner edits those paths and local tests. The Expo Router `apps/mobile/app/chat.tsx` route is an intentional sequential handoff: T001 scaffolds it, T158 makes offline and OpenAI chat work, and T128 integrates the full app; those cards cannot run concurrently. Contract/schema changes go through T002/T003 and trigger dependent rechecks. Composition owners edit only their integration root. Unsupported or unknown provider capabilities remain typed states, never optimistic booleans. Keep identifiers, secrets and telemetry rules from [contracts](02-contracts.md).

## Coordinator workflow

1. Select all ready cards whose direct dependencies are smoke-passed and owned paths are disjoint. Use separate branches/worktrees and assign as many as machines permit. The dependency-only maximum wave width is 48.
2. Workers return task ID, commit, changed paths, exact commands/results, feature IDs and specific pending deep proof or blocker. The coordinator checks ownership, merges one branch at a time and reruns changed-package checks.
3. Record task state in [status](status/TEMPLATE.md): queued, ready, running, review, implemented, blocked. Deep-verification cards separately mark their feature IDs verified. A failed deep test reopens the owning implementation card without halting unrelated lanes.
4. Hold only scarce Mac/iPhone/Android devices, signing or shared service staging in a reservation queue. Coding and fixture tests need no global semaphore. A failed card blocks only descendants.

The coordinator owns `plans/status/`; workers provide evidence paths under `docs/implementation/evidence/`. No worker pastes credentials, PINs, user prompts or huge logs into Markdown. Contract/schema proposals are reviewed and merged before dependent work changes.

## External dependencies

No store enrollment, physical device, model weight, paid API, relay domain, signing certificate or cloud entitlement is assumed present. T005 records native feasibility on available first-target hardware. Optional integrations are implemented behind fixtures before T128; T159A–H and T160–T169 require live evidence to mark them verified. A missing resource remains pending with a named owner, not passed. Public store submission needs a separate owner action after internal verification.
