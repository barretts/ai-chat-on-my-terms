# Ordered continuation queue

Next task: **C01**. Initial audit/checkpoint C00 is complete; see CURRENT_STATE.md and evidence/baseline.json. Recheck it only if source/environment changed.

## Immediate sequence

| Order | Card                                     | Direct continuation dependency | Scope                                                  |
| ----- | ---------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| 1     | [C01](tasks/C01-web-policy.md)           | Baseline                       | Persist Auto/Manual/Off; capability/offline policy.    |
| 2     | [C02](tasks/C02-autonomous-web-tools.md) | C01                            | Native autonomous web tool loop and citations.         |
| 3     | [C03](tasks/C03-audio-session.md)        | Baseline                       | Shared audio ownership and existing TTS adaptation.    |
| 4     | [C04](tasks/C04-ios-dictation.md)        | C03                            | iOS recognition native module and permissions.         |
| 5     | [C05](tasks/C05-dictation-ui.md)         | C04                            | Composer dictation, review/autosend and preferences.   |
| 6     | [C06](tasks/C06-tool-settings.md)        | C02                            | General tool settings, stable names and time built-in. |
| 7     | [C07](tasks/C07-http-mcp.md)             | C06                            | HTTP MCP discovery/execution/auth.                     |
| 8     | [C08](tasks/C08-searxng.md)              | C06                            | Configured SearXNG research.                           |
| 9     | [C09](tasks/C09-lmstudio-mcp.md)         | C06                            | Integrated LM Studio MCP.                              |
| 10    | [C10](tasks/C10-priority-integration.md) | C02,C05,C07,C08,C09            | Priority-feature integration checkpoint.               |

C07–C09 are independent after C06 but execute sequentially in the listed order by default. If a card genuinely waits for external resources, record the blocker and work on the next ready independent card. Never run overlapping composition edits concurrently.

Native proof can remain pending while non-native fixtures/code move ahead. Do not mark a native working milestone passed before the required compilation and phone exercise.

## Subsequent ordered batches

Before each batch, read its original cards, source evidence and corresponding PARITY.md rows. Preserve actual direct dependencies from those cards. This order expresses priority, not permission to skip dependency checks.

1. **Finish remaining voice:** T072 system output, T075 remaining languages, T077 local Whisper, T079 cloud voices, T080 automatic reading/transcription/settings, T074/T076/T078 host speech. T081 continuous/group/Call Mode follows its audio and group dependencies; do not pretend those are ready.
2. **Personas and groups:** T051 generator, T053 associations/sharing, T054 remaining model/parameter/workflow bindings, T055–T058 group editor/scheduling/streams/controls. Record a partial T061 integration checkpoint; full T061 waits for held Arena.
3. **Core parity debt:** remaining T033/T034 imports/model lifecycle, T031 background downloads, T028/T030 usable MLX, T037 summaries, T045 real embeddings and T043/T039 attachment/math gaps. Preserve current no-large-weight-hashing preference.
4. **Remaining tools/services:** T067 hosted search, T068 isolated code worker, T069 remaining presentation and T070 provider/group integration. Partial checkpoints are allowed; original aggregate dependencies still apply.
5. **Generated media:** T084 job/settings foundation; T085 A1111; T086 ComfyUI; T087 queues/video; T088 Core ML; T089 gallery; T091 Persona media; T092 integration.
6. **Companion and sync:** T093 crypto; T094 relay; T095 routing; T096 pairing UI; T097 binary forwarding; T098A/B/C plus T098 convergence; T099 selective Persona sync; T100 iCloud; T101 USB; T102 host UI; T103 integration. Use the project's frozen protocol, never the original product's protocol.
7. **Customization and services:** T104/T120 appearance; T108 lock; T110 encrypted backup; T107 entitlements; T111 accounts; T109 recovery; T112 purchases; T106 community; T113 support; remaining T118 consent/analytics. Accounts and hosted services remain optional for ordinary local chat.
8. **Automation/accessibility:** T114 widgets, T116 typed App Intents/deep links, T117A–H recipes and T117 aggregate, T119 localization/accessibility. Use locallab://, not original branding/schemes.
9. **Later platforms:** T119B/T157 iPad; T027/T032/T048/T073/T082/T115/T130 and T129–T132 Android; T040/T090/T105/T133/T136–T156/T134 full desktop; packaging T124/T125.
10. **Full integration and proof:** T128 only when all applicable original dependencies really pass. T122/T123 audits and T159A–H feed T159. Later T160–T169 feed T121; T126 learning guides; T135/T127 final parity/artifact audit.

## Held work

All new Arena UI, discovery, apply/history, telemetry activation and race launch work is held by the user. Preserve the existing T059 engine; do not build T060 or activate it in onboarding. AR-01–AR-09 stay visibly held.

T061 and its descendants may receive partial checkpoints but cannot be declared complete while T060 is held. Full parity requires user resumption and the remaining Arena implementation/proof.

## Original authority

[Original execution rules](../../plans/03-execution.md), [task cards](../../plans/tasks), [verification gates](../../plans/06-verification.md), and [coverage ledger](../../plans/05-coverage.md).

The source inventory and frozen contracts define original scope. User decisions in this handoff override older web-trigger behavior and Arena scheduling. Historical status files are evidence leads, not a current ready queue.
