# Coordinator handoff: start and finish the program

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](POWERSHELL.md).

Start [T001](../archived/plans/tasks/P00/T001.md), then [T002](../archived/plans/tasks/P00/T002.md) after T001 passes. T001A builds Mac/API shells in parallel with core T003/T004/T006/T007 lanes; T005A–D run concurrently after their direct prerequisites. Assign the ready queue from the [dependency waves](04-schedule.md), not a whole phase. Run [T021A](../archived/plans/tasks/P02/T021A.md) beside the GGUF lane, then prioritize [T158](tasks/P04/T158.md) so a physical iPhone can chat offline and through a configured OpenAI endpoint early. [T128](tasks/P11/T128.md) is the full working iPhone build. The phone's Mac companion supports the later remote/sync/voice routes.

Every assignment gets one task card, its dependency handoffs, the named feature rows, a branch/worktree and a reviewer. Workers stay within owned paths, run the card's quick check, then report commit/changed paths/commands/results/known defects. The coordinator merges one branch at a time, updates [status](status/TEMPLATE.md) and routes contract/schema changes through T002/T003.

After T128, start iPhone deep shards T159A–H and audits T122/T123 **in parallel** with iPad T119B/T157, Android ports/gates and full desktop UI/gates. T159 signs an internal iPhone build only when its deep evidence is complete. After later working builds, T160–T169 test platform differences; T121 reconciles their manifests against all 231 coverage rows. T135/T127 close the program after distribution artifacts and final audit.

Worker handoff:

```text
Task ID / commit / worktree:
Changed owned paths:
Feature IDs and implementation-smoke results:
Exact commands and build IDs:
Live evidence (only for deep-verification cards):
Pending later proof or external resource:
Defects and contract/schema requests:
Reviewer:
```

Provision the minimum iPhone/Mac/model resources and a controlled Responses-compatible network fixture for T005/T158 first. A disposable OpenAI credential can add live first-run smoke, but its absence does not block the fixture-labeled functional milestone; T159A still requires real OpenAI proof. Other paid vendor test accounts, Apple TestFlight/store sandbox, Google Play sandbox, hosted relay domain, iPad/Android/Windows/Linux hardware and signing are needed for the named **later** verification/distribution gates. Keep credentials in a secret manager outside the repository. A missing resource is a pending gate with an owner, never a reason to call fixture behavior production proof.
