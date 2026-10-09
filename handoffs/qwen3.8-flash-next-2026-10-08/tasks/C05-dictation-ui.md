# C05 — Dictation composer and voice preferences

Dependency: C04. Related original: T072/VO-07/VO-10 and T080. Next: C06.

## Goal and owned areas

Own composer dictation controls, the existing Voice Studio settings surface, and narrow chat speech-session integration.
Do not create competing voice routes: the current /speech route redirects to the voices panel in /chat.

Read advanced composer draft/preferences/send behavior; chat panel integration; existing speech screen;
C03/C04 interfaces and phone-sheet/keyboard patterns.

## Implementation decisions

- Show input language and recognition availability/network status.
- A microphone action starts dictation. Keep partial recognition in a preview; append final recognized text to the existing draft once.
- Cancel does not overwrite or clear the original draft. Empty/failed recognition does not send.
- Default to reviewing/editing text. Autosend is an explicitly selected, persisted preference and sends finalized text exactly once.
- Preserve attachments and the current send/reject/draft semantics. Do not duplicate user messages on retry.
- Stop capture when navigating away or suspending; coordinate with existing TTS playback through C03.
- Preserve neural voice download/select/rate controls, Persona bindings and compact keyboard layout.
- Web/unsupported platforms show honest capability states instead of a fake recording control.

## Acceptance

Permission denial and cancellation preserve a pre-existing draft and attachments.
Partial/final callbacks never produce duplicate text or sends.
Review mode does not send; autosend requires an explicit setting.
Locale/preferences survive reopen; navigation releases capture; TTS can run afterward.
Phone-width controls fit existing sheets and do not overlap the keyboard/taskbar.

## Checks and handoff

Focused composer/settings/session tests, mobile TypeScript and rendered phone interaction fixtures.
Physical iPhone recognition/layout/interruption results are recorded separately.
