# Execution-first concurrency schedule

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](POWERSHELL.md).

A phase groups related cards; it is not a barrier. Assign a ready card when its direct dependencies are implemented and its owned paths are free. Implementation cards need quick functional/contract smoke checks. **Deep device, service, performance and security campaigns start after a working build**, in T122/T123/T159A–H/T160–T169. The waves below assume unlimited workers; actual throughput is constrained by devices, credentials, signing and test services.

## Milestones in order

1. T001 establishes the iPhone workspace and route; T002/T003/T004/T006/T008, T005B, T037A, T039A, T041A and T021A open the minimal phone path. T001A builds Mac/API shells concurrently, while T005A/C/D, advanced providers, voice, media, services and desktop foundations proceed in their own lanes.
2. [T158](tasks/P04/T158.md) produces the first **working offline and OpenAI remote iPhone chat** at wave 6. Its 17 prerequisites include core schema/storage, GGUF probe/runtime, basic provider send/composer/transcript, events/capability ports, secure secrets and HTTP/SSE; Apple image/MLX, advanced cloud providers and Mac host work proceeds concurrently.
3. [T128](tasks/P11/T128.md) produces a **working full-feature iPhone build** at wave 12. It integrates all iPhone-applicable code and checks bounded routes, without claiming production-grade test coverage or public release.
4. After T128, run iPhone deep verification and hardening concurrently with iPad, Android and full desktop implementation. T157, T129–T132 and T134 are functional platform milestones. T159 signs a deep-verified iPhone internal release; T124/T125 package desktop/Android.
5. T160–T169 perform real-platform parity shards after relevant working builds while installer/store packaging proceeds. T121 aggregates all 231 feature rows; T135/T127 close the full program.

**The full iPhone working milestone has 135 ancestor cards and no Android, iPad-specific or full-desktop implementation ancestor.** T159 and deep-audit cards are descendants, not prerequisites, of T128.

## Critical gates

| Gate | Outcome | Direct prerequisites |
|---|---|---|
| [T005](../archived/plans/tasks/P00/T005.md) | Feasibility decision and pinned baseline | T005A, T005B, T005C, T005D |
| [T158](tasks/P04/T158.md) | First working iPhone offline and OpenAI chat | T008, T026, T037A, T039A, T041A, T021A |
| [T025](../archived/plans/tasks/P02/T025.md) | Provider integration and conformance gate | T017, T018, T019, T020, T021, T021A, T022, T023, T024 |
| [T036](tasks/P03/T036.md) | Inference and downloads integration gate | T026, T028, T029, T030, T031, T033, T034, T035 |
| [T049](tasks/P04/T049.md) | Complete-chat vertical slice gate | T025, T036, T037, T038, T039, T041, T042, T043, T044, T045, T046, T047, T008B |
| [T061](tasks/P05/T061.md) | Persona, memory, group and Arena integration gate | T049, T051, T052, T053, T054, T056, T057, T058, T060 |
| [T070](tasks/P06/T070.md) | Tools across providers integration gate | T025, T061, T063, T064, T065, T066, T067, T068, T069 |
| [T083](tasks/P07/T083.md) | Full voice integration gate | T061, T072, T074, T075, T076, T077, T078, T079, T080, T081 |
| [T092](tasks/P08/T092.md) | Images/video integration gate | T049, T085, T086, T087, T088, T089, T091 |
| [T103](tasks/P09/T103.md) | Remote, USB and sync integration gate | T061, T083, T092, T094, T096, T097, T098, T099, T100, T101, T102 |
| [T117](tasks/P10/T117.md) | Twenty-two Shortcut recipes integration gate | T117A, T117B, T117C, T117D, T117E, T117F, T117G, T117H |
| [T128](tasks/P11/T128.md) | Working iPhone full-feature build milestone | T103, T070, T106, T109, T110, T112, T113, T114, T117, T118, T119, T120, T158 |
| [T129](tasks/P11/T129.md) | Android runtime, download and chat parity gate | T128, T027, T032, T048, T039, T042, T043, T045 |
| [T131](tasks/P11/T131.md) | Android voice and call parity gate | T129, T073, T082, T130, T075, T079, T080 |
| [T132](tasks/P11/T132.md) | Android images, automation and accessibility gate | T128, T129, T092, T115, T117, T119 |
| [T134](tasks/P11/T134.md) | Working Mac, Windows and Linux desktop milestone | T133, T105, T090, T136, T137, T138, T139, T140, T141, T142, T143, T144, T145, T146, T147, T148, T149, T150, T151, T152, T153, T154, T155, T156 |
| [T157](tasks/P11/T157.md) | Working iPad full-feature milestone | T128, T119B |
| [T122](tasks/P11/T122.md) | Performance, battery and lifecycle audit | T049, T061, T083, T092, T103, T120, T128 |
| [T123](tasks/P11/T123.md) | Privacy and security integration audit | T070, T103, T109, T110, T111, T112, T118, T128 |
| [T159](tasks/P11/T159.md) | Deep-verified iPhone internal release gate | T128, T122, T123, T159A, T159B, T159C, T159D, T159E, T159F, T159G, T159H |
| [T124](tasks/P11/T124.md) | Desktop installers and companion release pipeline | T128, T040, T090, T102, T105, T119, T136, T137, T138, T139, T140, T141, T142, T143, T144, T145, T146, T147, T148, T149, T150, T151, T152, T153, T154, T155, T156, T134 |
| [T125](tasks/P11/T125.md) | Android native builds and distribution pipeline | T128, T129, T131, T132 |
| [T121](tasks/P11/T121.md) | Deep cross-platform evidence aggregation | T128, T129, T131, T132, T133, T134, T124, T126, T157, T125, T160, T161, T162, T163, T164, T165, T166, T167, T168, T169, T159 |
| [T135](tasks/P11/T135.md) | Final cross-platform parity and release gate | T121, T123, T124, T125, T132, T133, T134, T157, T159 |
| [T127](tasks/P11/T127.md) | Final parity, graph and artifact audit | T135, T126 |

## Maximum-concurrency waves

Every row shows cards that can run together if earlier dependencies have passed. Within a wave, reserve Mac/iPhone test devices, signing and shared staging services separately. The maximum dependency-only width is 48 cards.

| Wave | Ready cards | Count |
|---:|---|---:|
| 0 | T001 | 1 |
| 1 | T001A, T002 | 2 |
| 2 | T003, T004, T005A, T005B, T005C, T005D, T006, T007 | 8 |
| 3 | T003A, T005, T008, T009, T010, T011, T012, T013, T014, T015, T107, T118 | 12 |
| 4 | T008A, T008B, T016, T024, T026, T028, T029, T030, T031, T033, T037A, T038, T039A, T041A, T042, T043, T044, T045, T046, T047, T050, T052, T053, T059, T062, T071, T084, T093, T098B, T108, T110, T111, T114, T116, T120 | 35 |
| 5 | T017, T018, T019, T020, T021, T021A, T022, T023, T035, T037, T039, T041, T051, T054, T060, T063, T064, T066, T067, T068, T069, T072, T074, T075, T076, T077, T078, T079, T080, T085, T086, T088, T089, T094, T098A, T098C, T104, T109, T112, T113, T117A, T117B, T117C, T117D, T117E, T117F, T117G, T117H | 48 |
| 6 | T025, T034, T055, T065, T087, T091, T095, T096, T098, T106, T117, T119, T158 | 13 |
| 7 | T036, T056, T058, T097, T099, T100, T101, T102 | 8 |
| 8 | T049, T057, T081 | 3 |
| 9 | T061, T092 | 2 |
| 10 | T070, T083 | 2 |
| 11 | T103 | 1 |
| 12 | T126, T128 | 2 |
| 13 | T006A, T027, T032, T048, T073, T115, T119B, T122, T123, T130, T133, T159A, T159B, T159C, T159D, T159E, T159F, T159G, T159H | 19 |
| 14 | T040, T082, T090, T105, T129, T157, T159 | 7 |
| 15 | T131, T132, T136, T137, T138, T139, T140, T141, T142, T143, T144, T145, T146, T147, T148, T149, T150, T151, T152, T153, T154, T155, T156, T160, T163, T168 | 26 |
| 16 | T125, T134, T161, T162, T169 | 5 |
| 17 | T124, T164, T165, T166, T167 | 5 |
| 18 | T121 | 1 |
| 19 | T135 | 1 |
| 20 | T127 | 1 |

## Scheduling rules

- Prioritize T158 and then T128 on the critical path while unrelated lanes proceed in separate worktrees.
- Do not gate functional implementation on exhaustive paid-vendor, USB/iCloud, signing, accessibility matrix, security or performance proof. Log these as named T159 or T160–T169 verification work.
- A failing smoke check blocks only that card's descendants. A deep-verification failure creates a defect for its owner while independent implementation continues.
- The coordinator alone owns contract/schema changes, merges, plans/status and final coverage reconciliation. See [execution rules](03-execution.md) and [verification](06-verification.md).
