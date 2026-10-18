# C03 — Shared audio/session ownership

> Local workstation: Windows; run workspace commands in PowerShell. Follow the [PowerShell environment guide](../../../../plans/POWERSHELL.md).

Dependency: C00. Priority order follows C02; independent if C02 has an external blocker.
Original: [T071](../../../../plans/tasks/P07/T071.md). Next: C04.

## Goal and owned areas

Own packages/audio/session, shared speech contract additions, and adapters around existing platform/speech.
Preserve current neural TTS functionality.

Read the original card; actual contracts/ports.ts (currently only ProviderPort/ModelManagerPort, despite broader intended ports in the plan);
platform/speech/types.ts, state.ts and index.ts Stop/playback/resource handling; existing speech UI and Persona bindings.

## Implementation decisions

- Add published SpeechInputPort/SpeechOutputPort abstractions for availability, locale, partial/final recognition, start/stop/cancel, playback and disposal. Use typed capability/error states and AbortSignal.
- State machine: idle, listening, transcribing, generating, speaking; errors/cancellation settle consistently.
- One owner controls capture and playback. Close capture before playback; stop owned playback before capture.
- Track raw pending cleanup/drain promises. A canceled durable operation does not mean native resources are released.
- Adapt current OfflineSpeech instead of replacing pack storage, voice selection, rates, Persona preferences or Stop behavior.
- Keep ordered speech extensible for later groups; do not implement groups or CallKit now.
- Define interruption, navigation/suspension and disposal behavior. Do not automatically restart capture after interruption.

## Acceptance

Fake ports prove exclusive capture/playback, capture closed before speech, no self-transcription, repeated Stop safety and no new admission before drain.
Existing voices/rate/Persona state survive adaptation. Cancellation affects only owned work.
No code claims hardware routing or lock-screen behavior from fixtures.

## Checks and handoff

New coordinator contract/state tests, touched package/mobile typechecks and focused existing TTS/Persona regressions.
Record new exports, ownership/drain guarantees and pending native verification.
