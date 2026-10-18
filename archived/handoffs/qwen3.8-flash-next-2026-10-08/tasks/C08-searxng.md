# C08 — Configured SearXNG

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../../../plans/POWERSHELL.md).

Dependency: C06. Original: [T063](../../../plans/tasks/P06/T063.md). Next: C09.

## Goal and owned areas

Own packages/tools/searxng, research-provider configuration seam and focused tests.
Read T063; configured public/brave clients; C01 mode policy; C02 web-tool result interface; HTTP/SecretStore controls.

## Implementation decisions

- Add a configured JSON search endpoint with query/language filters, bounded results, source metadata and cancellation/deadline handling.
- Normalize results into the existing research source/result interface so automatic and manual paths both work.
- Extend selected-service configuration backward compatibly; retain existing public/brave preferences and keys.
- Honor configured endpoint auth and explicit local-HTTP authorization where relevant.
- Never silently substitute DuckDuckGo, Brave or hosted search after a SearXNG failure.
- Mode/capability/offline and per-turn research budgets are unchanged.

## Acceptance

Success, empty, malformed, quota/auth/network/timeout, cancellation and disabled-service cases.
Existing provider selection/credential migration survives reopen.
A tool-capable model can consume normalized search results and continue; no-tool models stay manual.
No request on opening/saving settings.

## Checks and handoff

Client/configuration tests, research-provider regressions and touched typechecks.
Live SearXNG proof is separate from fixture success.
