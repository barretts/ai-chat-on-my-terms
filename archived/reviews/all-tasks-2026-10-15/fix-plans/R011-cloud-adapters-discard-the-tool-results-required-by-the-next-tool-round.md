# R011 — Cloud adapters discard the tool results required by the next tool round

- **Priority:** P1
- **Original tasks:** T021, T022, T062, T070, C02, C10
- **Suggested owner:** Provider encoders and T070 tool integration
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Implement vendor-specific tool call/result replay in each affected adapter or supply a matching appendExchange mapper; preserve native call IDs and required reasoning blocks where applicable.

## Evidence and failure scenario

**Source:** [packages/providers/cloud/anthropic/src/index.ts:57](../../../../packages/providers/cloud/anthropic/src/index.ts#L57)

**Trigger:** Run a registered tool such as current_time or web_search with Anthropic, OpenAI advanced, Gemini or Mistral and start the following model round.

**Impact:** The app uses ToolLoopEngine's canonical assistant/tool exchange, but these provider encoders discard every kind=tool entry instead of translating its result. Several also omit the assistant tool-call structure. The model never receives the tool output, so autonomous tool requests cannot reliably reach a grounded final reply and may repeat until the loop limit.

**Review evidence:** appendToolExchange creates kind=tool rows in packages/tools/engine/src/index.ts:743. Mobile constructs ToolLoopEngine without appendExchange at screen.tsx:1754. Anthropic encoder accepts only user/assistant after system handling; OpenAI advanced line 50, Gemini line 304 and Mistral line 316 likewise filter out tool. No provider-specific replay mapper is supplied by composition.

**Evidence limit:** Confirmed by tracing canonical exchange into source encoders; live provider rounds not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T021, T022, T062, T070, C02, C10) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Trace canonical tool exchanges into Anthropic, OpenAI advanced, Gemini and Mistral request encoders.
3. Map assistant calls and tool results to each vendor format with stable call IDs and required native reasoning metadata.
4. Keep the normal mobile ToolLoopEngine path compatible; do not fix only an unused provider-specific helper.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Each affected provider receives the actual result of a current_time or web_search tool in the next round.
- [ ] Multiple calls and failures retain matching IDs and can terminate in a final reply without repeating solely because results were omitted.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
