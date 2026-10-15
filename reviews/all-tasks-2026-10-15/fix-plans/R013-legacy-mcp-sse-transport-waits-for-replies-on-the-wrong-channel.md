# R013 — Legacy MCP SSE transport waits for replies on the wrong channel

- **Priority:** P1
- **Original tasks:** T064, T070
- **Suggested owner:** T064 MCP HTTP client
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Keep the legacy GET stream active for the session and dispatch SSE message replies by JSON-RPC ID; treat POST responses as message acceptance.

## Evidence and failure scenario

**Source:** [packages/tools/mcp-http/src/client.ts:641](../../../packages/tools/mcp-http/src/client.ts#L641)

**Trigger:** Connect to a legacy HTTP+SSE MCP server whose POST accepts messages and whose GET stream delivers JSON-RPC replies.

**Impact:** Initialization POST acceptance is parsed as if it contained a JSON-RPC response. The legacy GET stream is no longer consumed after the endpoint event. Initialization fails or waits until timeout; no tools from compliant legacy servers are available.

**Review evidence:** discoverLegacySse stops iterating frames after the endpoint event at line 616 and calls postRpc for initialize at line 641. postRpc passes the POST response to readEnvelope. No persistent GET-stream response dispatcher exists. Legacy specification requires server replies as SSE message events: https://modelcontextprotocol.io/specification/2024-11-05/basic/transports

**Evidence limit:** Confirmed by source tracing against the primary legacy MCP specification; live server reproduction not executed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T064, T070) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Keep the legacy GET SSE stream alive after endpoint discovery and dispatch replies by JSON-RPC ID.
3. Treat POST responses as acceptance; route initialize, tools/list and tool calls through the shared response dispatcher.
4. Clean up pending requests/readers on cancellation, timeout and stream closure.
5. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] A legacy server returning POST acceptance and replies only on GET completes initialize, discovery and a call.
- [ ] Concurrent IDs match correctly; disconnect/cancel settles pending requests instead of hanging.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
