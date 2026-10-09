# C04 — iOS system speech recognition

Dependency: C03. Original: [T072](../../../plans/tasks/P07/T072.md). Next: C05.

## Goal and owned areas

Own modules/speech-system/ios, its TypeScript facade/tests, and narrow mobile module registration/permission configuration.
Use the existing Expo SDK 57 native-module scaffold pattern, not an unpinned replacement stack.

Read compatibility AppleMLProbe Expo registration/pod/Swift bridge; current mobile package/app config;
C03 speech-input contract; original T072; native build/install guides.

## Implementation decisions

- Bridge Apple Speech recognition and audio capture to SpeechInputPort. Expose recognition availability, permission state, locale and whether operation is on-device or network-backed.
- Add NSMicrophoneUsageDescription and NSSpeechRecognitionUsageDescription.
- Request permission only on the user's recognition action. Denial/unavailable locale is actionable and leaves the draft unchanged.
- Prefer on-device recognition for supported locales. Report network-backed operation before capture when using that route; an offline-only choice must reject network fallback.
- Emit session-scoped partial/final results; ignore stale callbacks after cancellation/disposal.
- Stop finalizes capture; cancel discards the temporary recognition. Await microphone/recognizer cleanup and dispose listeners.
- Keep this card focused on dictation. System TTS is the remaining T072 output subcard, not a reason to replace current neural voices.
- Pin current package/toolchain versions; follow existing module registration and migration conventions.

## Acceptance

Adapter fixtures cover denied permission, unsupported locale, partial/final ordering, Stop/cancel, stale callback rejection and cleanup.
Native compilation confirms module registration and required usage strings.
A phone check confirms mic permission, selected language, recognized text and capture cleanup. Mark unavailable physical proof pending explicitly.

## Checks and handoff

Typecheck and adapter tests; native compile when resources are available; describe exact build ID and physical evidence separately.
Do not mark C05 app integration done on the basis of native facade tests.
