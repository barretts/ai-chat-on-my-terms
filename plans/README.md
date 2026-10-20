# AI Chat on My Terms: current implementation and verification work

Start with the [remaining work ledger](status/README.md). As of the 2026-10-18 cleanup, **128 unfinished task cards** remain here (118 original + 10 P12 persona-group-chat cards); **84 integrated implementation records** are in [archived/plans/tasks/](../archived/plans/tasks/). All **202 original task IDs** and the [231-record feature inventory](../docs/lm-mini-features.md) are preserved. Archiving an implementation unit does not certify its device, service or release behavior.

Use the [iPhone installation guide](../docs/iphone-installation.md) for build 21 and the [local UI testing guide](../docs/local-ui-testing.md) for browser checks. A successful signed preview does not establish the full-feature T128 or deep-verified T159 milestone. Missing native bridges, routes, backend startup wiring, platform ports and live proof remain active.

Read [architecture](01-architecture.md), [contracts](02-contracts.md), [execution rules](03-execution.md), [feature coverage](05-coverage.md), [verification gates](06-verification.md), and [sources and decisions](07-sources-and-decisions.md) as needed. On Windows, use the [PowerShell guide](POWERSHELL.md). The original [dependency schedule](../archived/plans/04-schedule.md) and [bootstrap coordinator handoff](../archived/plans/08-coordinator-handoff.md) are historical context; use current source and status before assigning work.

## Active phase indexes

| Phase | Remaining scope |
| --- | --- |
| [P03](phases/P03.md) | Native runtime, download and model integration gaps |
| [P04](phases/P04.md) | Attachment codecs, embeddings, lifecycle and chat acceptance |
| [P05](phases/P05.md) | Persona workflow bindings, group composition and Arena UI |
| [P06](phases/P06.md) | Hosted search/sandbox startup and full tools integration |
| [P07](phases/P07.md) | Platform speech, continuous voice and full voice integration |
| [P08](phases/P08.md) | Core ML, playable galleries and media integration |
| [P09](phases/P09.md) | Paired phone/Mac UI, live sync, CloudKit, USB and sharing |
| [P10](phases/P10.md) | Optional services, native automation, workflows and accessibility |
| [P11](phases/P11.md) | Working builds, platform ports, deep verification and distribution |
| [P12](phases/P12.md) | Persona group chats: settings/rounds storage, Liquid model, turn controller, Drunk recall, avatars (GR-13) |

P00–P02 and completed units from later phases are in the [archive](../archived/README.md). Original phase indexes, dated status ledgers, research, feasibility notes and implementation receipts remain available there for provenance. The [cleanup audit](../archived/cleanup-2026-10-18.json) records every card's disposition and every moved file's original hash.

## Continuing work

Read one active card, its dependency handoffs and relevant source. Check current implementation before trusting an old pending label. Implement within its owned paths, run the focused check, and record exact results and unresolved proof using the [status template](status/TEMPLATE.md). Archive links describe existing work, not a queue to restart.

An implemented unit has working code and a bounded smoke check. A verified feature additionally needs applicable real-device/backend evidence in T159A–H or T160–T169. T128 is a working iPhone milestone; T159 is an internally verified release. T121/T135/T127 close the cross-platform program only after all feature rows and artifacts are audited. Missing credentials, hardware, unmounted routes and fixture-only behavior remain pending.
