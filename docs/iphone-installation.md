# Install LocalLab on an iPhone

The phone must run iOS 17 or later. The `preview` profile in `apps/mobile/eas.json` creates a signed internal Release build with its JavaScript bundle included. It runs without a Metro development server. The profile pins Node 24.13.1 and pnpm 8.15.9, matching the local verification environment.

## Cloud build from Windows

This route needs an Expo account and an active Apple Developer Program membership. EAS creates an ad hoc provisioning profile containing the registered iPhone. See [Expo internal distribution](https://docs.expo.dev/build/internal-distribution/).

Create an account at [Expo signup](https://expo.dev/signup) if needed, and keep it on the Free plan. That plan includes 15 iOS builds per calendar month in the low-priority queue. Free accounts cannot incur overage charges; builds stop when the monthly quota is exhausted. [Expo pricing](https://expo.dev/pricing), [billing FAQ](https://docs.expo.dev/billing/faq/)

The browser sign-in command prints a login URL. Open it on the same Windows PC and leave the command running until it reports success; its callback uses localhost. Sign in on Expo's website. [EAS browser login source](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/src/user/expoBrowserAuthFlowLauncher.ts)

Run EAS commands from `apps/mobile`, keeping the entire monorepo available so EAS can include workspace packages, `pnpm-lock.yaml`, and `patches/`. See [Expo monorepo setup](https://docs.expo.dev/build-reference/build-with-monorepos/).

```powershell
Set-Location C:/code/cht/apps/mobile
& ../../tools/run-pnpm.ps1 dlx eas-cli@24.8.0 login --browser
& ../../tools/run-pnpm.ps1 dlx eas-cli@24.8.0 init
& ../../tools/run-pnpm.ps1 dlx eas-cli@24.8.0 device:create
& ../../tools/run-pnpm.ps1 dlx eas-cli@24.8.0 build --platform ios --profile preview
```

Sign in through the CLI prompts. `init` links or creates the project under the selected Expo account and writes its real project identity. Open the device registration URL on the iPhone and complete registration before starting the build. During build setup, choose the Apple team and let EAS manage the signing credentials. Open the finished build's installation URL in Safari on that registered phone. Follow the installation and Developer Mode prompts. [Expo installation guide](https://docs.expo.dev/tutorial/eas/internal-distribution-builds/)

## Local build on a Mac

Xcode can install a development build using a free Apple Account's Personal Team; paid membership is optional for this local route. Free provisioning expires after seven days and requires rebuilding/reinstalling. [Apple membership comparison](https://developer.apple.com/support/compare-memberships/)

With the repo and dependencies available on the Mac, connect and trust the iPhone, enable Developer Mode, and run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @locallab/mobile exec expo run:ios --device
```

If automatic signing needs setup, select the Apple team in the generated Xcode project. This development build uses Metro while developing. [Expo local device builds](https://docs.expo.dev/develop/development-builds/introduction/)

## Current verification

The iOS JavaScript/Hermes export passes. Expo configuration introspection succeeds with SDK 57, bundle identifier `app.locallab.mobile`, iOS 17 deployment target, and the required usage descriptions. Expo discovers the local AppleMLProbe pod/module; React Native discovers `llama.rn` and the UI native dependencies.

The Expo project is linked as [@barrett/locallab](https://expo.dev/accounts/barrett/projects/locallab), project ID `15eddc95-17b4-4c17-9371-c26c8db770cf`. Browser login and the pinned CLI's account lookup succeed. On 2026-09-26, `account:usage barrett --json --non-interactive` confirms the Free plan with iOS builds 0/15 and total builds 0/30.

`tools/setup-iphone-signing.ps1` guides private Apple login, Website device registration and preview credential configuration in an interactive terminal. All calls share the explicit workspace package store and metadata cache (`.pnpm-store` and `tmp/eas-cli-cache`), so offline resolution works in the user's terminal. `-Check` executes the actual cached device command's help without starting Apple authentication. It writes only a timestamp to ignored `tmp/iphone-deploy/signing-ready.json` after both signing commands succeed. The user completes Apple authentication directly in their terminal.

On 2026-09-27, device registration and EAS-managed ad hoc signing completed for the user's iPhone. A fresh quota check confirmed the Free plan with iOS builds 0/15 and total builds 0/30 before submission.

The first signed native preview build [36004774-e40b-4a1f-a4b7-3e5b598d4fef](https://expo.dev/accounts/barrett/projects/locallab/builds/36004774-e40b-4a1f-a4b7-3e5b598d4fef) finished successfully at 2026-09-27 17:02:03 UTC. The cloud worker installed all 58 workspace projects from the frozen lockfile, completed prebuild and CocoaPods installation, bundled the app, compiled and signed the Release archive, and uploaded the IPA. The native build includes AppleMLProbe and llama.rn. The generated provisioning profile includes the registered iPhone.

The user installed and exercised this first binary, then reported the failures described below. It remains a historical artifact; the local fixes are not in it. Native compilation does not establish that every feature or inference backend works; the AppleMLProbe MLX/Core ML inference methods still report `ENGINE_NOT_LINKED`.

Expo Doctor reported nonblocking follow-ups in this successful build: SDK 57 rejects the legacy `newArchEnabled` config field, the app directly depends on `expo-modules-core`, and pnpm peer variants produce duplicate physical installations of some native packages. The legacy config field has since been removed. The dependency follow-ups remain recorded for native registration investigations. Ignored `tmp/iphone-deploy/` holds the submission response, final status, and downloaded build logs.

A read-only quota check on 2026-09-27 after that first build confirmed the Free plan with iOS builds 1/15, total builds 1/30, estimated total cost 0, and overage 0. No replacement build had been submitted when that check ran.

## Phone feedback and local regression checks

The user exercised the first preview and reported ineffective theme/setup buttons, text overlapping the camera cutout, and failure to enter chat. Removing the app and retrying installation produced no error message. The existing artifact and build page remained reachable with HTTP 200 on 2026-09-27; the reinstall cause is unresolved.

The working tree now contains persisted themes/setup choices, a safe-area wrapper, native crypto injection, real local-provider connection/model binding, ordered settings saves, browser file/archive adapters and interrupted-generation recovery. The [local preview guide](local-ui-testing.md) explains how to exercise these shared screens against the running llama.cpp server on Windows. The [live local validation evidence](implementation/evidence/live-local-app-validation-2026-09-27.md) records the earlier interaction checks and actual model requests; the [expanded workflow audit](implementation/evidence/app-workflow-audit-2026-09-27.md) records subsequent fixes and their current evidence.

The final iOS release export includes the native AbortSignal compatibility fix and the provider-save navigation fix. It completed with 1,638 modules, 43 assets and a 5,169,923-byte Hermes bundle in `tmp/app-workflow-ios-export-release-final/`. These changes are not included in the first binary.

The replacement iOS preview [34eb8beb-267d-4688-b069-6f85c04069d7](https://expo.dev/accounts/barrett/projects/locallab/builds/34eb8beb-267d-4688-b069-6f85c04069d7) was submitted at `2026-09-27T20:24:21.615Z` with app version `0.1.0` and build number `2`, and finished at `2026-09-27T20:29:46.566Z`. Submission uploaded a 1.8 MB source archive. The worker completed native compilation, archived and signed the app with the existing ad hoc credentials, then uploaded the IPA. Receipts and logs are in `tmp/app-workflow-iphone/`; the build fingerprint is `407432e5e40a04a582b2549c7695245a09f6b114`. The checkout commit alone does not identify the uncommitted source included in this build.

The actual IPA download returned HTTP 200 and contained 16,961,103 bytes. ZIP/Info.plist inspection confirms `app.locallab.mobile`, version `0.1.0`, build `2` and minimum iOS `17.0`. Its embedded provisioning profile includes the registered iPhone, matches team `KQJWD7GN74`, and expires at `2027-09-27T16:42:38Z`. The saved inspection is `tmp/app-workflow-iphone/ipa-inspection.json`; it extracts the profile metadata without independently validating its signature. Native archive logs confirm successful ad hoc signing. Physical installation and the phone workflow checks remain unverified.

This replacement build's Expo Doctor passed 18/21 checks and reported nonfatal dependency follow-ups: direct `expo-modules-core`, same-version pnpm peer-context duplicates for Expo/React Native modules, and React Native Web `0.21.0` versus expected `^0.21.2`. Compilation and upload succeeded. These warnings do not establish the cause of the earlier silent reinstall failure.
