# R015 — MCP discovery escapes the chat setup deadline and can lock sending indefinitely

- **Priority:** P1
- **Original tasks:** T064, T066, T049, T070
- **Suggested owner:** MCP client and mobile tool collection
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Accept and propagate the caller AbortSignal through createMcpTools/discoverTools and apply one bounded setup deadline to every discovery request; ensure deadline cleanup runs in finally.

## Evidence and failure scenario

**Source:** [packages/tools/mcp-http/src/tools.ts:55](../../../packages/tools/mcp-http/src/tools.ts#L55)

**Trigger:** Enable an MCP server that successfully initializes, then leaves its tools/list response open without replying.

**Impact:** collectMcpTools passes the 15-second chat deadline only to initialize. createMcpTools replaces it with a fresh never-aborted signal, and the client has no configured timeout. Chat remains awaiting discovery with sendPending=true and working=true, preventing subsequent sends or mode changes until restart.

**Review evidence:** createMcpTools creates new AbortController().signal and awaits discoverTools with it. collectMcpTools creates a client without timeoutMs and awaits createMcpTools after initialize. screen.tsx:1678 creates a 15-second controller but awaits collectMcpTools before starting the run; its finally releases send admission only after that await settles.

**Evidence limit:** Confirmed by source cancellation/data-flow tracing; stalled-server reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T064, T066, T049, T070) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Propagate the caller AbortSignal through createMcpTools and every discovery request instead of replacing it.
3. Apply the chat setup deadline to initialize and tools/list together and clear owned timers/listeners in finally.
4. Confirm mobile send admission is released when setup aborts.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A server that initializes then stalls tools/list is interrupted by the setup deadline.
- [ ] The UI releases sendPending/working and accepts another send; user cancellation also settles discovery.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
