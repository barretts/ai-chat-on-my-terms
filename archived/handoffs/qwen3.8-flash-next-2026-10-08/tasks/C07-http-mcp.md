# C07 — HTTP MCP

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../../../plans/POWERSHELL.md).

Dependency: C06. Original: [T064](../../../plans/tasks/P06/T064.md). Next: C08.

## Goal and owned areas

Own packages/tools/mcp-http, HTTP MCP settings adapter and focused protocol tests.
Read T064; C06 server/registry interfaces; host-bound HTTP transport; existing ToolLoopEngine cancellation/replay.

## Implementation decisions

- Support Streamable HTTP negotiation and supported legacy SSE compatibility. Reject unsupported transports with an explanation.
- Add/edit labeled configured server URL, Bearer/custom-header refs, explicit discovery/test and enablement.
- Discover tools, validate argument schemas and map invocation/progress/results to the common registry.
- Use stable names/identity; friendly renaming must not alter a remote tool's original name.
- Resolve auth only for the configured origin, using existing redirect/HTTP authorization controls. Never forward secret headers to unrelated origins.
- Cancel discovery/execution and dispose owned sessions. Preserve typed offline/auth/timeout/protocol/unsupported errors.
- Do not auto-enable discovered tools or silently replace a failed server.
- Keep public web URL restrictions on web_fetch; a separately configured LAN MCP endpoint uses existing explicit local-HTTP authorization.
- Do not claim a provider supports calls simply because an MCP server is available.

## Acceptance

Fixture server covers discovery, schema validation, execution/continuation, failure, cancellation and legacy negotiation.
Host redirect tests prove no secret leakage.
Disabled server/tools issue no calls; rename preserves identity.
Selected model capability gates remain intact.

## Checks and handoff

Protocol tests, shared tool-loop integration fixture and touched typechecks.
Record fixture server details and any real-host execution separately.
