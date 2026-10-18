# Research evidence and remaining verification

**Reviewed September 25, 2026.** The workspace was empty at inspection; no existing implementation or project instructions were found. The research used public primary sources. No account was created, subscription purchased, app installed, or binary decompiled.

## Source coverage

| Material reviewed | What it contributes |
| --- | --- |
| [Product page](https://lmmini.com/) | Product boundaries and major capabilities. |
| [Docs index](https://lmmini.com/docs.html) | All 14 linked topic guides were opened. |
| [Getting started](https://lmmini.com/docs/getting-started.html) | Setup paths and first-run behavior. |
| [Providers](https://lmmini.com/docs/providers.html) | Connection types and capability restrictions. |
| [Remote access](https://lmmini.com/docs/connect.html) | Home/Connect distinction and USB scope. |
| [Sync](https://lmmini.com/docs/sync.html) | Data scope, reconciliation, disable/retry behavior. |
| [Chat](https://lmmini.com/docs/chat.html) | Conversation behavior, context, composer. |
| [Personas](https://lmmini.com/docs/personas.html) | Character configuration. |
| [Groups](https://lmmini.com/docs/group-chat.html) | Participant controls and scheduling. |
| [Voice](https://lmmini.com/docs/voice.html) | Speech engines and conversation modes. |
| [Tools](https://lmmini.com/docs/tools.html) | Search, MCP, sandbox, execution boundaries. |
| [Images](https://lmmini.com/docs/image-gen.html) | Backends, workflows, placeholders. |
| [Arena](https://lmmini.com/docs/arena.html) | Comparison modes, metrics, entitlements. |
| [Desktop](https://lmmini.com/docs/desktop.html) | Desktop shell and diagnostic pane. |
| [Settings](https://lmmini.com/docs/settings.html) | Parameter layers, UI/data/security controls. |
| [Troubleshooting](https://lmmini.com/docs/troubleshooting.html) | Failure categories and recovery. |
| [Changelog](https://lmmini.com/changelog.html) | Visible mobile, Home, Connect release histories. |
| [App Store](https://apps.apple.com/us/app/lm-mini/id6751125309) | More recent releases and store information. |
| [Google Play](https://play.google.com/store/apps/details?id=net.neuro9.lmmini) | Android claims and current visible release notes. |
| [Downloads](https://lmmini.com/download.html), [Connect](https://lmmini.com/connect.html) | Distributed products and companion availability. |
| [Shortcuts](https://lmmini.com/shortcuts/) | All listed workflow names and public entry-point families. |
| [Models](https://lmmini.com/models.html), [phone guide](https://lmmini.com/phones.html) | Hardware/catalog context; not an installed model inventory. |
| [Persona article](https://lmmini.com/blog/personas.html), [group article](https://lmmini.com/blog/group-chat.html) | Additional user-facing explanations. |
| [Voice article](https://lmmini.com/blog/voice-chat.html), [Arena article](https://lmmini.com/blog/arena.html), [on-device article](https://lmmini.com/blog/on-device-ai.html) | Cross-checks for major feature families. |
| [Privacy policy](https://lmmini.com/privacy.html), [terms](https://lmmini.com/terms.html) | Local/cloud boundaries and service entitlements. |

The sitemap could not be fetched through the browsing tool. Navigation and the docs index were used instead. The linked “one app” article also failed to fetch; its product distinction was corroborated through the download and desktop pages.

## Conflicting or incomplete evidence

The following observations should not be converted into unqualified implementation requirements:

| Topic | Conflict / limitation | How the inventory handles it |
| --- | --- | --- |
| Release currency | Website mobile history is older than the store history. | Later store additions receive UP IDs. |
| PIN recovery | Settings/privacy text requires reinstall; later store notes offer recovery. | Retains historical lock details and flags the update. |
| Persona sync | Sync guide excludes it; later Home notes add it. | Version-specific SY-10 supersedes the older exclusion. |
| Android parity | Store notes and device-specific docs differ in detail. | Does not assume every iOS feature ships on Android. |
| OS minimums | Setup guide and current iOS store requirements differ. | Does not use mobile minimums to choose a Windows target. |
| Privacy declarations | Store labels differ from the optional services described in the policy. | Uses the policy for service boundaries, without equating local-first with zero network use. |
| Companion versus client | Download copy can sound like Windows has the full app. | PL-04 distinguishes the companion explicitly. |
| Public source code | Policy mentions a community GitHub stub, but no authoritative repository was located. | No claim that the production source is available. |
| Automation reference | The “Apple Shortcuts docs” link resolves to general Settings. | Records entry points, leaves exact parameter contract unverified. |

The policy describes the community build as separate from production cloud services. That alone does not prove access to complete production code. [Privacy policy](https://lmmini.com/privacy.html)

## Installed-app audit checklist

These questions remain open. They do not erase the documented features; they delimit what a later parity audit must prove.

1. Record app, Home, and Connect versions independently. Export a screen/settings inventory for each target build.
2. Check actual free/Pro behavior, trial duration, model-slot/download restrictions, cloud/sandbox limits, and platform-specific entitlements.
3. Enumerate file/audio import formats, extraction behavior, attachment limits, OCR paths, and LM Studio import/export schemas.
4. Inspect regenerate-variant navigation, message editing/deletion, bulk operations, and conversation search behavior. Do not assume undocumented actions exist.
5. Capture every parameter name, range/default, backend mapping, and precedence edge case.
6. Inspect memory creation/edit/delete, extraction triggers, scope, duplicate handling, and the stopping-generation case.
7. Verify autonomous-group triggers, scheduling order, parallel transcript ordering, and group voice-provider support.
8. Measure Arena timing boundaries and history persistence; determine whether ranking is manual or automatic.
9. Check transcription input paths, timestamp/diarization support, voice-device controls, and interruption behavior.
10. Verify image queue cancellation/reordering, gallery scope, video outputs, and prompt/workflow validation.
11. Determine remote protocol framing, crypto, pairing revocation, supported routes, binary forwarding, and reconnect rules before pursuing official-client interoperability.
12. Verify sync on Android, Persona selection, attachments, conflict/deletion semantics, offline edits, and multi-peer behavior.
13. Verify lock biometrics/recovery, backup restore scope, passphrase handling, and whether app lock encrypts data at rest.
14. Enumerate news/widget controls, supported locales, accessibility behavior, and exact automation arguments/results.
15. Capture remaining support/community/account screens; identify which require production services.

## Research completion standard

The deliverable is a public-source feature inventory with a Windows implementation blueprint. Publicly documented feature coverage can be audited by matching the topic/source table to the inventory. Installed-app behavior, private service contracts, and binary-level parity remain unverified and are explicitly outside what this research can establish.

No app implementation has been claimed or tested. The Windows blueprint is an independently proposed architecture, not a recovered LM Mini codebase.
