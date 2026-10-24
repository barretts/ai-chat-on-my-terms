# Native screenshot capture plan and October 23 results

Updated October 23, 2026. The approved prepare-and-push scope supersedes the original October 19 upload plan below. The owner subsequently authorized uploading all prepared screenshots. Screenshot uploads are complete; App Review submission and public release remain outside scope. The owner also authorized the TestFlight binary upload.

## Current results and scope

- Implemented adaptive safe-area layout, stable conversation/composer identity across breakpoints, iOS scene lifecycle, and iPhone portrait/both landscape orientations. iPad includes all four orientations for native multitasking.
- Captured six current-source native Release screenshots on each of iPhone 18 Pro Max/iOS 27.0, iPad Pro 13-inch (M5)/iOS 27.0, and iPhone Duo/iOS 27.1. Dedicated simulators preserve existing simulator data.
- All sample chats were imported through the normal system document picker. The package is `screenshots/0.1.0/`; see its README, manifest, image validation, contact sheets, and separate layout evidence.
- Source checkpoint `bb04869f1ae2f7478b2c5ecc6464ac0d2c5c1dfd`, simulator build 29. These screenshots do **not** represent production build 23. Store build 32 uses the same UI source with its automatic build counter increment.
- Rotation, keyboard, selected conversation and draft retention were exercised. iPad resizing crossed the wide/phone breakpoint while preserving its draft. Duo evidence covers Closed, Open and Partially Open poses and both inner-display aspects.
- Mobile/shared UI typecheck passed; release configuration/scene tests: 6 passed; chat composition suite: 311 passed across 40 files. Changed-source formatting and whitespace checks passed.
- Store-signed 0.1.0 (32) was built locally and Apple processed it as `VALID`. Internal TestFlight state is now `IN_BETA_TESTING`; build 32 is assigned to Owner with the owner tester account. The build-specific exempt OS-encryption declaration is recorded in the build handoff. See `../docs/builds/ios-production-32.md`.
- All 18 prepared screenshots were uploaded to the existing English 0.1.0 draft and verified through fresh Apple readback. iPhone and iPad use the compatible screenshot-set API; Duo uses the current Asset Library API and its discovered `IPHONE_DUO_PROFILE`. Native dimensions, source identity, processing and order were verified. See `screenshots/0.1.0/apple-upload-receipt.json`. Physical-device inference, privacy/export declarations and TestFlight installation remain separate release gates.

## Original October 19 procedure (historical)

The procedure below records the original intent. Its build-23 and screenshot-upload instructions are superseded by the current scope above.

## Objective

Produce **six clean screenshots for iPhone and six for iPad**, showing the real native app with fictional saved conversations. Deliver the ordered PNG files, contact sheets, and capture records, then upload the verified sets to the existing **English (US), version 0.1.0** App Store Connect draft for app **6824682448**. Do not submit for review.

Use full-screen app captures without added headlines, device frames, or composited artwork. Keep the supplied illustrated poster in the separate marketing package.

## Procedure

### 1. Prepare a native simulator build

- Use the application source corresponding to successful production build **23**, comparing it with the recorded source checksums. Record any differences before capturing.
- Build a **Release simulator app** with its JavaScript embedded, development client disabled, and no developer API keys or default private-server connection. The store IPA cannot run in Simulator.
- Use local Expo prebuild and Xcode compilation. Keep generated native projects and build products outside tracked source; do not increment the public build number or start another EAS cloud build.
- Restore dependencies from the committed lockfile before building. Diagnose installation or compilation failures without upgrading dependencies or changing product behavior merely to obtain screenshots.
- Use dedicated capture simulators on the installed **iOS 27.0** runtime: **iPhone 18 Pro Max** and **iPad Pro 13-inch (M5)**.
- Both device types and the runtime were available on this Mac during planning. Create dedicated instances to preserve existing simulator data.

Capture at native resolution and validate it against Apple's accepted sizes. The target families are the large Dynamic Island iPhone display and the 13-inch iPad display; iPad screenshots are required because the app supports iPad. [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)

### 2. Prepare consistent sample content

- Create a small, versioned fixture using the app's existing conversation-import format. Import it through the normal app flow.
- Include three fictional conversations:
  - **Weekend in Kyoto:** a concise itinerary with headings and a short checklist.
  - **A clearer project update:** a short writing request and revised update.
  - **Learn something new:** an explanation followed by a useful follow-up question.
- Keep names, dates, and text identical across devices. Use no personal histories, credentials, private endpoints, or real account details.
- Record these as imported sample conversations. Do not label them as proof of offline generation, model speed, or a live provider response.
- Use the built-in default theme: light appearance for shots 1–5 and dark appearance for shot 6.
- Set a consistent status bar—9:41 and full battery—dismiss keyboards unless needed, finish animations, and clear permission dialogs before capture.

No shipping screenshot mode, fake provider, or new public API is needed.

### 3. Capture this ordered set on both devices

| Order | Screenshot          | Required state                                                                                                               |
| ----- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 01    | Main conversation   | “Weekend in Kyoto,” showing a readable request and formatted answer with the normal composer                                 |
| 02    | Phone models        | Existing model catalog with names and download information; no fabricated installed or running status                        |
| 03    | Connection choices  | Real connection setup showing supported local/cloud choices, with no entered secrets or private development defaults         |
| 04    | Saved conversations | The three imported conversations, showing useful titles and navigation                                                       |
| 05    | Chat controls       | Existing settings for model/context/generation controls, with readable labels and no unavailable service presented as active |
| 06    | Dark conversation   | “A clearer project update,” showing the same real conversation UI in dark appearance                                         |

- Navigate through the native app using accessibility identifiers and labels.
- Use a connected native simulator interaction tool when available. If none is connected, use a small XCUITest runner in the generated capture workspace; do not substitute browser screenshots.
- Capture PNGs with `simctl io screenshot`. Preserve the full app image without stretching, cropping, or painting over UI.
- Exercise the iPad layout independently rather than enlarging iPhone images.
- Save permission, loading, error, and empty-state captures as internal evidence only—not in the upload set.

### 4. Validate, package, and upload

- Store deliverables under `submission/screenshots/0.1.0/`, with separate `en-US/iphone/` and `en-US/ipad/` folders and filenames `01-conversation.png` through `06-dark-conversation.png`.
- Produce a contact sheet for each device and a manifest containing source commit/checksums, simulator model, OS, native dimensions, theme, fixture identity, filename, and image hash.
- Inspect every image at full resolution. Check text readability, safe areas, clipping, missing icons, blank regions, keyboard overlap, and unintended personal or developer information.
- Validate accepted dimensions, PNG decoding, absence of transparency, order, uniqueness, and exact file count. Apple does not accept screenshot transparency. [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
- Inspect the existing Apple screenshot sets before changing them. Preserve any existing files; upload only the new verified English sets and set their order explicitly.
- Wait for Apple asset processing, then fetch the saved sets again to verify all 12 screenshots, their order, and successful processing.
- Commit and push the capture workflow, fixtures, screenshots, manifest, and updated handoff. Keep temporary native builds and simulator data out of Git.

## Stopping Conditions

- **Success:** all 12 images pass local inspection and appear in the correct App Store Connect draft slots with successful processing.
- If a screen fails, preserve the error evidence and retry once after correcting its specific cause. A persistent product defect blocks that screenshot; do not conceal it or substitute a mock screen.
- If source changes are needed to fix visible app behavior, identify that the screenshots require a replacement production candidate. Do not claim they match build 23.
- If Apple authentication expires, retain the complete local package and request secure reauthentication. Do not repeatedly retry uploads or submit the app for review.

## Procedure Risks

- Simulator builds provide screenshot evidence, not physical-device acceptance of build 23.
- Fictional imported chats demonstrate the real saved-conversation interface, not inference performance.
- Simulator rendering or model-runtime limitations may expose genuine failures. Preserve them as release findings rather than creating misleading screenshots.
- Capture-only generated project changes must remain separate from shipping application code.

## Evaluation

- Confirm the native Release app launches without Metro on both simulators.
- Verify fixture import, conversation reopening, navigation, theme switching, and unchanged sample content across devices.
- Inspect each screenshot individually and in its ordered contact sheet.
- Verify Apple's processed assets through fresh readback; distinguish “captured locally” from “saved in Apple.”

**Settled choices:** clean app captures and fictional saved chats. **Default:** include upload to the existing draft, since no files-only preference was selected. Scope is English iPhone and iPad screenshots; no video preview, additional localization, paid AI calls, App Review submission, or public release.
