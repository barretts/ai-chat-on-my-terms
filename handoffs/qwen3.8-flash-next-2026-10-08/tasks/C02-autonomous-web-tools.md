# C02 — Autonomous native web research

Dependency: C01. Next: C03. Original related behavior: TL-09/TL-10/TL-11 and ER-03.

## Goal and owned areas

A capable selected model decides to search/read, executes real tools and continues its answer.
Own apps/mobile/composition/tools research orchestration, narrow chat/composer integration, and focused unit/browser tests. Reuse the existing engine.

Read:

- composition/chat/web-research.ts: client search/fetchPage, source fitting, event persistence and current prepass
- brave-web-search.ts and web-research-settings.ts: configured client
- packages/tools/engine/src/index.ts: RegisteredTool, policy snapshot, loop/replay
- features/workspace-files/tools.ts; screen.tsx around capability resolution, budgets and existing ToolLoopEngine wrapping
- providers/compatible-local tool definitions/replay and native NInfer tests
- Existing automatic-web-research.spec.ts (currently tests explicit commands, not autonomous decisions).

## Implementation decisions

- Register stable web_search and web_fetch tools using existing clients. Search takes a bounded query; fetch takes a validated public URL. Return structured sources with URL/title/text/kind and useful limitation/error details.
- Auto + confirmed tools: yes advertises both tools without requiring search words/chips. System guidance explains freshness/uncertainty/source needs and when not to browse.
- The model may refine queries or read result pages. Do not replace autonomy with keyword-triggered unconditional prefetch.
- Share one ToolLoopEngine/registry with currently permitted workspace functions. Preserve file save verification, revision checks and safe NInfer replay.
- Retain six rounds, twelve calls, 300-second loop deadline. Limit research to two searches/four reads per turn. Retain per-request 20-second deadlines, bounded results/response bytes and header isolation.
- Charge definitions/results to the active context budget, keeping mandatory instructions/current message and response reservation.
- A composition event wrapper can derive Source events from validated web ToolResults; deduplicate and resequence all emitted events monotonically, with one terminal event. Persist sources immediately.
- Do not also run the manual prepass for the same autonomous turn. Manual/non-tool behavior stays available; no hidden planner, alternate model or search-company fallback.
- Stop cancels retrieval and inference. Retrieval failures are visible structured results; do not invent citations or treat challenge/error pages as evidence.
- Retrieved text is untrusted data and cannot change tool permissions or offline settings.

## Acceptance

A plain current-information question reaches a fixture model with tools and executes search -> fetch -> final answer.
A follow-up can refine the query. A simple answer makes zero research requests when the model chooses none.
No/unknown capability, saved off and offline turns make no autonomous requests or planner calls.
Test cancellation, failed/empty/blocked pages, citations after reopen, source sequence/terminal uniqueness, combined file+web calls, budget exhaustion and service key isolation.

## Checks and handoff

Focused research/composition/compatible-tool tests; mobile and touched package typechecks; phone-width browser case.
Record fixture vs live evidence clearly. Native phone/live API proof may remain pending.
