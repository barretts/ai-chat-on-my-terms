# Apple interface handoff

Prepared October 19, 2026. No Apple review submission or public release has been performed.

## October 23 update: Duo support, native captures and TestFlight

The current UI source is `bb04869f1ae2f7478b2c5ecc6464ac0d2c5c1dfd`. It adds Duo-compatible scene lifecycle, adaptive safe areas, stable draft/navigation state through resizing, and iPhone rotation. iPad multitasking retains all four required orientations. Bundle ID, EAS identity, marketing version and saved-chat formats are preserved.

The local screenshot package at `screenshots/0.1.0/` contains 18 native Release PNGs, three contact sheets, fictional import fixtures, capture tooling, per-image provenance, a manifest and separate keyboard/rotation/folding/window-resize evidence. The iPhone, iPad and Duo dimensions match Apple's current published screenshot sizes. All 18 English screenshots are now uploaded, processed and ordered in the existing 0.1.0 draft. The receipt at `screenshots/0.1.0/apple-upload-receipt.json` records Apple image/placement IDs, dimensions, order, states and source hashes. These current-source simulator captures supersede the old build-23 capture brief; they must never be described as build-23 screenshots.

The owner separately authorized TestFlight delivery. **Store-signed 0.1.0 (32) has been built locally**, with embedded JavaScript, iPhone/iPad support, Xcode/iOS SDK 27.1 and validated distribution entitlements. See `../docs/builds/ios-production-32.md` for artifact hash and provenance. Apple has accepted and processed the build: `VALID`, build ID `951d2d6d-2609-4849-b3d1-c951e9b5462c`. Internal TestFlight state is `MISSING_EXPORT_COMPLIANCE`, so installation availability remains blocked by that declaration. The earlier authentication issue is resolved; no credentials are stored here. Screenshot readback confirms six iPhone, six iPad and six Duo images in order; the draft remains `PREPARE_FOR_SUBMISSION`.

Keep build 23 as historical evidence only. Qualify build 32 on a physical iPhone after Apple accepts/processes it. Export compliance remains unset; do not infer an exemption. Existing privacy, provider-consent, public-link and real inference acceptance items below remain open unless independently verified. The owner has not authorized App Review submission or public release.

## Files ready for review

- `en-US/metadata.json`: copy-ready field values, subject to URL verification and release acceptance.
- `en-US/description.txt`: conservative listing copy. Do not add planned features.
- `../site/public/`: homepage, support, and privacy pages for `aichat.sosuke.com`.
- `../docs/app-store-submission.md`: technical preparation, evidence, and blockers.

## In App Store Connect

1. Find the existing app record for bundle ID `app.locallab.mobile`; create a record only if none exists. Do not change the bundle ID or EAS project identity.
2. Confirm the intended public marketing version. The current project still uses `0.1.0`; do not create a mismatched version record.
3. Upload the finished production IPA with Transporter, or authorize EAS Submit separately. An EAS build alone does not place the binary in App Store Connect. Never use `--auto-submit` for this handoff.
4. Wait for Apple processing. Review warnings, SDK details, export-compliance questions, and the archive's privacy report. Select the exact accepted build.
5. Install that build using TestFlight and complete the candidate acceptance checks before review submission.
6. Enter approved listing fields from `en-US/`. Confirm live HTTPS pages at all three URLs. Add copyright, review contact and phone, pricing, availability, and release options using the owner's decisions.
7. Complete the current age-rating questionnaire based on actual functionality and content controls. Do not infer a rating merely from an AI label.
8. Complete App Privacy from actual SDK and service data flows; the repository is not evidence for a blanket “Data Not Collected” declaration. Review chat content, attachments, audio, diagnostics, identifiers, cloud providers, and optional services separately. Only the owner should accept the accuracy attestation after review.
9. Resolve export compliance from the encryption actually shipped. No exemption flag has been added. A custom encrypted companion protocol exists in source; determine whether it is present and functional in this archive.
10. Supply candidate-matched iPhone and iPad screenshots. `supportsTablet` remains true. Never use a browser rendering as proof of an iOS candidate or fabricate screenshots of unfinished features.
11. Finish review notes with a reproducible core-chat route and exact model/device requirements. Reviewers cannot access the developer's private home server. Provide any required review credentials securely in the review fields, never in these files.
12. Keep review submission and public release under the owner's control. Do not press Submit for Review as part of this preparation.

## Candidate acceptance sheet

Record the exact app version/build, device and OS, test date, tester, result, and evidence for each row:

| Check                                                                                                 | Result  |
| ----------------------------------------------------------------------------------------------------- | ------- |
| Clean install opens without Metro, developer credentials, or home LAN                                 | Pending |
| Supported model download/import finishes and reports errors usefully                                  | Pending |
| On-device chat works in airplane mode                                                                 | Pending |
| Cancel, background/resume, relaunch and saved history                                                 | Pending |
| Cloud destination/data disclosure and explicit consent before content upload; decline prevents upload | Pending |
| Provider changes and Persona bindings cannot bypass consent                                           | Pending |
| Photos/camera, microphone/speech, Files and denied permissions                                        | Pending |
| Conversation deletion, exported copies and credentials behavior                                       | Pending |
| Every reachable feature is functional or honestly unavailable                                         | Pending |
| iPad layout, keyboard, accessibility and large text                                                   | Pending |
| Public privacy/support links work from inside the app                                                 | Pending |
| Native privacy manifest/SDK inventory and encryption assessment                                       | Pending |

## Screenshot brief

Capture the actual TestFlight candidate with synthetic conversations. Start with a readable conversation, followed by on-device model selection, user-controlled connections, saved conversations, and one verified attachment flow. Omit any feature not accepted on the candidate. Use the current App Store Connect slot specifications for both device families. Remove private hosts, API keys, personal names, and real conversations. Optional preview video can wait; do not make it a prerequisite for the first listing.

## Authentication

Expo and Apple authentication succeeded. Local store build 32 was signed and uploaded; all 18 screenshots were also uploaded using the existing Apple session. Any future password/2FA prompt belongs in a secure local credential flow. The canonical host is `aichat.sosuke.com`; hosting and DNS setup are outside this preparation. Cloudflare authentication is not required. No passwords or verification codes belong in chat or checked-in files.

In-app privacy/support links have now been added to the Settings support section. Verify them on the production candidate after the public site is deployed; source implementation alone does not establish reachable HTTPS pages.

## Owner-supplied marketing poster

The illustrated “AI Chat — On My Terms!” poster is preserved unchanged in `../site/public/assets/ai-chat-on-my-terms-poster.png` and featured on the prepared homepage. See `marketing/README.md` for dimensions and provenance. It is promotional artwork; the native current-source screenshot package is complete and uploaded; physical-device candidate acceptance remains open.

## Verified Apple record

Created the App Store Connect app on October 19, 2026 using the authenticated owner session:

- Name: AI Chat on My Terms
- Apple app ID: `6824682448`
- Bundle ID and SKU: `app.locallab.mobile`
- Primary locale: `en-US`
- [App Store Connect record](https://appstoreconnect.apple.com/apps/6824682448)

The production submit profile now pins this app ID and Apple team, avoiding creation of a second record. This configuration does not itself upload any build or submit for review. Public listing fields, screenshots, privacy and export declarations remain to be completed/verified.

Verified iOS draft version: changed the newly created default `1.0` draft to match the configured candidate version `0.1.0`; release type is `MANUAL`, state `PREPARE_FOR_SUBMISSION`, version record `a0785cdf-0e39-4bf6-aa2c-2b152bbf4387`. This is draft setup only, not an App Review submission.

## Historical store candidate (superseded by local build 32)

The historical candidate was **0.1.0 (23)**, Expo build `9bd18bf0-3b54-4af5-8221-643bec7f8145`; build 22 failed and must not be used. [Download IPA](https://expo.dev/artifacts/eas/6zUZ85Ne_e-ptGd6ChFemTihUQKcgUQKR6Kqqb_qtKk.ipa?download=1). Local copy: `.logs/app-store-production-23/AI-Chat-on-My-Terms-0.1.0-23.ipa` from repository root. SHA-256 `a2c8d599f9d40afc4d342512bfeb5bb4c3e101110f766c6ab41b7d81ba4c9d6f`. App identity, iOS 26.5 SDK and required memory entitlements were inspected in the downloaded artifact. This candidate predates build 32. Current Apple upload and qualification state is recorded in the October 23 update above.

## Listing content now saved in Apple

As of October 19, 2026 at 5:43 PM America/Chicago, App Store Connect has the English description, keywords, promotional text, subtitle, marketing/support/privacy URLs, Productivity category, copyright, and reviewer contact (including the owner's existing review phone) plus draft review notes. Fresh readback verified each text field and reviewer detail. No phone number is stored in this handoff. The version remains Prepare for Submission with manual release. Earlier references above to locally prepared-only listing text are superseded by this saved state. That October 19 snapshot predates the successful build-32 and screenshot uploads documented above. Final declarations and physical-device qualification remain open.
