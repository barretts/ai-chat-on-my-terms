# C01 — Persistent automatic web policy

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../../../plans/POWERSHELL.md).

Dependencies: C00 audit. Next: C02. Requested extension mapped to TL-09/TL-11; do not change original IDs.

## Goal and owned areas

Add the settings/policy foundation for autonomous research without requiring per-turn chips.
Own chat web-research settings, its settings panel/policy tests, and narrowly needed composer preference plumbing. Do not implement the loop until C02.

Read:

- apps/mobile/composition/chat/web-research-settings.ts and web-research-settings-panel.tsx
- web-research.ts: resolveWebResearchIntent and offline-command helpers
- features/composer/advanced/composer.tsx: current search state/payload
- Existing preference and immutable migration patterns; relevant tests only.

## Implementation decisions

- Add WebResearchMode = auto | manual | off, persisted app-wide; allow an explicit conversation override with inheritance.
- A missing preference defaults to auto. Retain selected public/brave service and opaque key refs. Save/replace/remove-key operations must preserve mode.
- Auto admits autonomous tools only when actual selected-model capability is yes. No/unknown retains manual workflow; no model-planning call or fallback provider.
- Explicit per-turn off or a direct offline/no-web instruction vetoes research. An old default-false chip is neutral, not a stored veto.
- Manual keeps current explicitly requested or enabled search/link fetching. Off emits no research requests; explain unavailable requests without silent browsing.
- Keep forcing a turn's research separate from changing the saved default.
- Implement backward-compatible persistence under the existing migration discipline. Fresh/upgrade/reopen checks must cover it.
- Describe automatic availability accurately; C01 alone is not delivery of autonomous browsing.

## Acceptance

Persist default/mode/override across reopen; preserve existing provider/key rows; unrelated settings saves retain mode.
Test auto with yes/no/unknown capability; manual explicit requests; off; inherited override; offline instruction; quoted/code examples.
No requests merely from opening/saving settings. No extra model calls.

## Checks and handoff

Run focused settings/intent/composer tests and mobile TypeScript. Use local Vitest directly if pnpm remains unavailable.
Record preference migration, exported type, check results, source locations and pending C02 integration.
