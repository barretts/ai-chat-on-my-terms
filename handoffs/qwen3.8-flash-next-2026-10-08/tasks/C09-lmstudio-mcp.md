# C09 — LM Studio integrated MCP

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../../plans/POWERSHELL.md).

Dependency: C06. Original: [T065](../../../plans/tasks/P06/T065.md). Next: C10.

## Goal and owned areas

Own packages/tools/mcp-lmstudio, integrated-name settings adapter and focused provider fixtures.
Read T065; existing LM Studio native adapter/stateful continuation; C06 identities/policy; C02 shared loop.

## Implementation decisions

- Treat host-configured integrated MCP names separately from remote HTTP MCP URLs.
- Let users configure names exposed by the host and enable/disable each integration; do not assume a phone can read the host's mcp.json directly.
- Pass the correct LM Studio native v1 integration references and preserve selected provider/model/stateful continuation.
- Friendly rename does not change the integrated reference sent to the server.
- Show missing/unavailable plugin errors and capability limitations.
- Do not advertise this mechanism for Ollama or arbitrary compatible servers.
- Keep credential isolation, cancellation and policy snapshots consistent with the common tool path.

## Acceptance

LM Studio fixture covers correct integration references, enablement/disablement, missing-plugin error, continuation and cancellation.
Rename retains original reference. Other providers never receive LM Studio integration fields.
General HTTP MCP and workspace tools still behave correctly.

## Checks and handoff

Native-adapter fixtures, tool composition checks and touched typechecks.
Real LM Studio/MCP host and physical phone proof remain named later evidence.
