# C06 — General tool settings and current time

Dependency: C02. Original: [T066](../../../plans/tasks/P06/T066.md), TL-01. Next: C07.

## Goal and owned areas

Own packages/tools/builtins, mobile tool-settings UI/store and narrow composition/tools policy wiring.
Read ToolRegistry/ToolRunPolicy, current web/file tool orchestration, settings/SecretStore patterns and T066.

## Implementation decisions

- Mount global tool enablement, conversation inheritance/override, individual enables and effective-policy display.
- Preserve engine precedence: participantEnabled ?? chatEnabled ?? globalEnabled. Participant controls can be added with groups later.
- Default global tools on for existing authorized workflows. External servers/tools require configuration and enablement.
- Stable server/tool identity is independent from friendly label/rename. Naming must meet registry constraints and avoid collisions across servers.
- Add current-time built-in using injected clock, locale and timezone.
- Show bounded/unlimited-round policy accurately: null removes the round cap, not deadline/resource limits.
- Credentials/custom headers are masked and stored only through host-scoped SecretStore refs. SQLite contains no raw key/header material.
- Build a common settings seam for C07–C09 without fake discovery controls or optimistic provider capabilities.
- Registry/settings changes apply to the next run, preserving immutable in-flight policy.
- Effective deny removes tool definitions and prevents calls; explicit offline mode separately vetoes web even when other tools remain enabled.

## Acceptance

Disabled entries are not advertised/executed. Saved global/chat settings resolve correctly after reopen.
Rename retains identity/history. Time tests use an injected clock.
Web/file workflows still obey budgets and their existing user authorization.
No requests just from opening/saving settings; no raw credentials in persistence/logs.

## Checks and handoff

Built-in/policy/store/UI tests, tools-engine regressions and touched typechecks.
Record the common server configuration interface for C07–C09.
