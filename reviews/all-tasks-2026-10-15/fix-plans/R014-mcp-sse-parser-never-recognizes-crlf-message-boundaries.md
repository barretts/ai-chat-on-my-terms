# R014 — MCP SSE parser never recognizes CRLF message boundaries

- **Priority:** P1
- **Original tasks:** T064, T070
- **Suggested owner:** T064 MCP stream framing
- **Status:** Ready for implementation; fix not performed by this plan.
- **Dependencies:** None required; review shared-file coordination in the index.

## Outcome

Normalize line endings incrementally, including split CRLF across chunks, before detecting blank lines; bound retained frame bytes and cancel the owned reader on exit.

## Evidence and failure scenario

**Source:** [packages/tools/mcp-http/src/client.ts:528](../../../packages/tools/mcp-http/src/client.ts#L528)

**Trigger:** Receive an MCP SSE response framed with CRLF lines and CRLF blank lines, such as data: {...} followed by two CRLF sequences.

**Impact:** The parser searches the unnormalized buffer for LF-LF. CRLF-CRLF does not contain that sequence, so no frame is yielded. Initialization or tool calls hang until their timeout; without a timeout the retained buffer can grow indefinitely.

**Review evidence:** readEventStreamFrames searches buffer.indexOf("\n\n") before normalizing CRLF in the extracted frame. Thus valid CRLF streams never reach the normalization or JSON-RPC parser.

**Evidence limit:** Confirmed by literal delimiter/control-flow inspection; live stream execution not performed. The proposed fix remains a hypothesis until the failure scenario is checked against the changed implementation.

## Implementation plan

1. Re-read the current source, applicable AGENTS.md instructions, related task cards (T064, T070) and existing verification coverage. Reconfirm the failure scenario; source line numbers below are review-time coordinates.
2. Implement incremental SSE line framing that accepts LF and CRLF, including CRLF split across chunks.
3. Preserve multiline data semantics and bound buffered frame data; cancel the owned reader when the operation exits.
4. Implement the smallest complete fix for this finding and update affected callers/contracts. Record files changed, the evidence supporting the fix, checks actually performed and any unverified platform behavior.

## Acceptance criteria and proposed verification

- [ ] Identical SSE messages framed with LF or CRLF yield identical JSON-RPC envelopes.
- [ ] Split delimiters, multiple frames and unterminated oversized frames are handled without hangs or unbounded growth.
- [ ] Preserve the relevant security, transaction and compatibility guarantees; do not bypass the failing path or suppress its error to claim success.
- [ ] Record verification commands/results or the precise reason a platform check remains unrun. Follow the execution session's instructions on permission to add or run tests; this plan does not override them.

## Handoff and completion

Limit the change to this finding and necessary affected callers. Read [INDEX.md](./INDEX.md) before editing shared files. If the finding is already fixed or disproved at the current tip, report the counterevidence instead of changing code unnecessarily. Keep the finding ID in the completion report. Do not mark the review resolved solely because a patch exists; distinguish implemented work from unrun acceptance checks.
