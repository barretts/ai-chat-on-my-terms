# LocalLab: execution-first iPhone plan

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](POWERSHELL.md).

This is an independent, cross-platform mobile app plan based on the [231-record feature inventory](../docs/lm-mini-features.md). It has **202 bounded task cards**. The first target is **iPhone**. A Mac companion is built where the phone needs remote model, speech, USB or sync routes. iPad, Android and full Mac/Windows/Linux desktop clients follow the working iPhone milestone. Original product branding, artwork, prompts and pairing protocol are not reused; the official OpenAI API is an explicitly supported provider endpoint.

**Build before deep testing.** [T158](tasks/P04/T158.md) is the first real iPhone chat with both offline GGUF and an [OpenAI Responses remote endpoint](../archived/plans/tasks/P02/T021A.md). A user can enter a key and model ID, select the OpenAI path, and stream a reply without an account or hosted app proxy. [T128](tasks/P11/T128.md) integrates the full iPhone feature set into a working development build. Cards before these milestones use quick contract/functional smoke checks. After T128, eight independent iPhone domain shards, performance and security audits feed the [deep-verified internal iPhone release](tasks/P11/T159.md). Later platform builds and their separate verification shards converge at T121/T135/T127. Functional milestones never claim production verification.

Read [architecture](01-architecture.md), [contracts](02-contracts.md), [execution rules](03-execution.md), [dependency schedule](04-schedule.md), [feature ledger](05-coverage.md), [verification gates](06-verification.md), [sources and choices](07-sources-and-decisions.md), and the [coordinator handoff](08-coordinator-handoff.md). The 12 files in [phases](../archived/plans/phases/P00.md) are navigation indexes; every implementation/verification unit has its own card under tasks/. Earlier [research notes](../docs/research-notes.md) and [Windows blueprint](../docs/windows-blueprint.md) are context; this directory is the execution authority.

## Phase map

| Phase | Focus |
|---|---|
| [P00](../archived/plans/phases/P00.md) (archived) | Bootstrap and frozen contracts |
| [P01](../archived/plans/phases/P01.md) (archived) | Shared foundations |
| [P02](../archived/plans/phases/P02.md) (archived) | Providers and networking |
| [P03](phases/P03.md) | Local inference and model lifecycle |
| [P04](phases/P04.md) | Chat, files and retrieval |
| [P05](phases/P05.md) | Personas, groups and Arena |
| [P06](phases/P06.md) | Tools and search |
| [P07](phases/P07.md) | Voice and transcription |
| [P08](phases/P08.md) | Images and generated media |
| [P09](phases/P09.md) | Companion, remote access and sync |
| [P10](phases/P10.md) | Personalization, accounts and automation |
| [P11](phases/P11.md) | Working builds, deep verification and distribution |

Ledger status: P00–P02 shipped fully and are archived under [archived/plans/](../archived/plans/); live status ledgers exist in [status/](status/TEMPLATE.md) for P03–P06 only. P07–P11 were executed directly against their task cards, so their current state lives in git history, the [build records](../docs/builds/) and the archived [2026-10-15 review](../archived/reviews/all-tasks-2026-10-15/fix-plans/INDEX.md). Create P07–P11 ledgers from the template before scheduling further work in those phases.

## For a 64k-context implementing model

1. Read this README, 01–03, one phase index, one ready card, its direct dependency handoffs and the feature rows named on that card. Do not load the full plan into one context.
2. Implement only the card's owned paths in a separate worktree. Use frozen ports and fakes until sibling code is merged. A task should consume under **48k total tokens**, leaving at least 16k of the model's 64k for unexpected work. If a card grows, split it into owned subcards before coding.
3. Run the card's quick check, return commit/paths/check result and unresolved issues. The coordinator merges and updates status. Deep-verification cards later gather real device/service proof.
4. Schedule every ready card with disjoint paths concurrently. No phase-wide wait is needed. The dependency-only schedule reaches **48 simultaneous cards**; physical devices, signing and shared staging need separate reservations.

## What completion means

An implemented row has working code and a bounded smoke check. A verified row also has its applicable real-device/backend evidence in T159A–H or T160–T169. T128 is a working iPhone build, **not** an App Store release. T159 signs an internally tested iPhone build after deep verification. T135/T127 complete the whole cross-platform program only after all 231 rows and artifacts are audited. A placeholder, fixture-only integration, unavailable credential or untested platform stays pending in the verification ledger.
