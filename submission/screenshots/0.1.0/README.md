# Native iOS screenshot package

English screenshots of **AI Chat on My Terms 0.1.0**, captured from the native Release app on dedicated local simulators. These captures supersede the earlier plan to photograph production build 23. Source checkpoint: `bb04869f1ae2f7478b2c5ecc6464ac0d2c5c1dfd`.

## Deliverables

Each folder contains six ordered, opaque PNGs:

| Folder             | Simulator                 | Runtime  | Native portrait dimensions |
| ------------------ | ------------------------- | -------- | -------------------------- |
| `en-US/iphone/`    | iPhone 18 Pro Max         | iOS 27.0 | 1320 × 2868                |
| `en-US/ipad/`      | iPad Pro 13-inch (M5)     | iOS 27.0 | 2064 × 2752                |
| `en-US/duo-outer/` | iPhone Duo, outer display | iOS 27.1 | 1398 × 2034                |

Order: conversation, model catalog, connection choices, saved conversations, response controls, dark conversation. The contact sheets are review aids, not upload assets. `image-validation.json`, per-image `.capture.json` files, and `manifest.json` record dimensions, hashes, fixture identity, build/source provenance, appearance, and device details.

The dimensions were checked against [Apple's screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/) on October 23, 2026. Apple's specifications explicitly accept Duo outer and inner display sizes. Additional inner-display, folding, rotation, keyboard and iPad window-resize captures live under `evidence/` and are kept out of the upload sets.

## Apple upload results

All **18 English screenshots** are uploaded, processed, and ordered in the existing App Store Connect 0.1.0 draft for app `6824682448`. Fresh readback verifies native dimensions, image identity, processing states and the six-screen sequence in each device group. See `apple-upload-receipt.json` for Apple image/placement IDs, source hashes and the verification timestamp. The iPhone/iPad source MD5 checksums also match Apple's readback. Duo images were uploaded and placed through the current Asset Library API using the runtime-discovered `IPHONE_DUO_PROFILE` and the matching 1398 × 2034 specification.

Only the 18 upload candidates were placed on the product page; keyboard, rotation, fold-transition and resized-window evidence remain in the separate `evidence/` package. The app remains `PREPARE_FOR_SUBMISSION`. No App Review submission or public release occurred. Store build 32 is processed as `VALID`; TestFlight now reports `IN_BETA_TESTING`, with build 32 assigned to the internal Owner group and the owner tester account. See `../../../docs/builds/ios-production-32-owner-testflight.json` for the current readback; the earlier screenshot-upload receipt preserves the compliance status observed at that earlier time.

## Sample content and appearance

`fixtures/sample-conversations.json` contains three fictional conversations: **Weekend in Kyoto**, **A clearer project update**, and **Learn something new**. All three simulators imported this file through the app's normal **Import & export → Import LM Studio export** flow and the system document picker. No database seeding, fake provider, shipping screenshot mode, or live paid AI request was used.

The built-in appearance is light for images 01–05 and dark for image 06. Wide layouts use the existing Focus conversation control for conversation captures. System status bars are set to 9:41 and full battery; the app's own desktop clock continues to show the real capture time. Natural scrolling is preserved; no screenshot was cropped, stretched, composited, or painted over.

## Reproduce

1. Restore locked dependencies and run `tooling/prepare-build.sh /tmp/<new-build-directory>` from the repository. Generated native projects and build products stay temporary. Xcode simulator signing is enabled because the real secure store requires an application entitlement.
2. Create dedicated simulators, install the Release app, and set light appearance/status-bar overrides. Preserve other simulator instances and their data.
3. Generate the standalone native UI driver with `tooling/create-runner.rb`, then `xcodebuild build-for-testing`. Build separate `.xctestrun` files for iOS 27.0 and iOS 27.1; their runtime injection paths differ.
4. Start the UI driver with `xcodebuild test-without-building`, a specific simulator UDID, and parallel testing disabled. `tooling/command.py <UDID> tree` reads the current native hierarchy. Actions use accessibility labels/identifiers; coordinate fallback is reserved for an inspected shifted target.
5. Place the fictional JSON in that dedicated simulator's local Files provider, then import through the normal picker. Use `tooling/refresh-set.py <UDID> <iphone|ipad|duo-outer>` to collect the six real screens.
6. Run `tooling/verify-layout.py` for keyboard and rotation evidence. `tooling/verify-duo-fold.py` uses Device Hub's named Open/Partially Open/Closed accessibility controls. The direct XCTest rotation setter did not rotate the Duo scene; that attempt is marked partial in `evidence/duo-outer/verification.json`. Actual Duo rotations are in the Device Hub folding report. Avoid changing Duo screen power: an early capture instance exposed a SpringBoard display-mode crash, and a fresh instance was used for the final run.
7. After returning to the outer display, refocus the composer at its inspected trailing edge before tapping the native delete key. XCTest can retain a stale element hit point or place the caret in the middle after a display transition; the folding driver accounts for this.
8. Run `tooling/validate-images.py`, inspect every native PNG and contact sheet, run `tooling/build-manifest.py <Release-simulator-app-path>` to record provenance, then stop the owned UI-driver sessions with `command.py <UDID> stop`.

`capture.py` calls `simctl io screenshot --mask=black`. It preserves RGB pixels while removing an entirely opaque alpha channel, retains the raw framebuffer hash, and rejects blank frames. Temporary native projects, simulator data, archives, signing credentials, and production IPAs stay out of Git.

## Release boundary

This package establishes native UI rendering and recorded simulator interaction. It does not establish physical-device model execution, live cloud-provider behavior, TestFlight installation, App Review acceptance, or public release. Store build 32 and its current Apple-upload state are recorded in `docs/builds/ios-production-32.md`.
