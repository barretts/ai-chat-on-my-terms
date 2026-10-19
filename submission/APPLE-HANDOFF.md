# Apple interface handoff

Prepared October 19, 2026. No Apple review submission or public release has been performed.

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

| Check | Result |
| --- | --- |
| Clean install opens without Metro, developer credentials, or home LAN | Pending |
| Supported model download/import finishes and reports errors usefully | Pending |
| On-device chat works in airplane mode | Pending |
| Cancel, background/resume, relaunch and saved history | Pending |
| Cloud destination/data disclosure and explicit consent before content upload; decline prevents upload | Pending |
| Provider changes and Persona bindings cannot bypass consent | Pending |
| Photos/camera, microphone/speech, Files and denied permissions | Pending |
| Conversation deletion, exported copies and credentials behavior | Pending |
| Every reachable feature is functional or honestly unavailable | Pending |
| iPad layout, keyboard, accessibility and large text | Pending |
| Public privacy/support links work from inside the app | Pending |
| Native privacy manifest/SDK inventory and encryption assessment | Pending |

## Screenshot brief

Capture the actual TestFlight candidate with synthetic conversations. Start with a readable conversation, followed by on-device model selection, user-controlled connections, saved conversations, and one verified attachment flow. Omit any feature not accepted on the candidate. Use the current App Store Connect slot specifications for both device families. Remove private hosts, API keys, personal names, and real conversations. Optional preview video can wait; do not make it a prerequisite for the first listing.

## Outstanding authentication

Expo login succeeded. Store signing requires the Apple account `bsonntag@gmail.com`; use Expo's secure local credential prompt for password/2FA. The canonical host is `aichat.sosuke.com`; hosting and DNS setup are outside this preparation. Cloudflare authentication is not required. No passwords or verification codes belong in chat or checked-in files.

In-app privacy/support links have now been added to the Settings support section. Verify them on the production candidate after the public site is deployed; source implementation alone does not establish reachable HTTPS pages.

## Owner-supplied marketing poster

The illustrated “AI Chat — On My Terms!” poster is preserved unchanged in `../site/public/assets/ai-chat-on-my-terms-poster.png` and featured on the prepared homepage. See `marketing/README.md` for dimensions and provenance. It is promotional artwork; actual release-candidate screenshots remain pending.

## Verified Apple record

Created the App Store Connect app on October 19, 2026 using the authenticated owner session:

- Name: AI Chat on My Terms
- Apple app ID: `6824682448`
- Bundle ID and SKU: `app.locallab.mobile`
- Primary locale: `en-US`
- [App Store Connect record](https://appstoreconnect.apple.com/apps/6824682448)

The production submit profile now pins this app ID and Apple team, avoiding creation of a second record. This configuration does not itself upload any build or submit for review. Public listing fields, screenshots, privacy and export declarations remain to be completed/verified.

Verified iOS draft version: changed the newly created default `1.0` draft to match the configured candidate version `0.1.0`; release type is `MANUAL`, state `PREPARE_FOR_SUBMISSION`, version record `a0785cdf-0e39-4bf6-aa2c-2b152bbf4387`. This is draft setup only, not an App Review submission.

## Successful store candidate

Use **0.1.0 (23)**, Expo build `9bd18bf0-3b54-4af5-8221-643bec7f8145`; build 22 failed and must not be used. [Download IPA](https://expo.dev/artifacts/eas/6zUZ85Ne_e-ptGd6ChFemTihUQKcgUQKR6Kqqb_qtKk.ipa?download=1). Local copy: `.logs/app-store-production-23/AI-Chat-on-My-Terms-0.1.0-23.ipa` from repository root. SHA-256 `a2c8d599f9d40afc4d342512bfeb5bb4c3e101110f766c6ab41b7d81ba4c9d6f`. App identity, iOS 26.5 SDK and required memory entitlements were inspected in the downloaded artifact. Upload to the existing Apple app `6824682448`, wait for processing, and qualify this exact candidate through TestFlight before review submission. No binary upload has occurred in this preparation.
