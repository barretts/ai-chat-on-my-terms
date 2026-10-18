# Install LocalLab on an iPhone

## Latest internal build: 21 (October 17, 2026)

[Install LocalLab build 21](https://expo.dev/accounts/barrett/projects/locallab/builds/1e7b4d3f-c5f8-4903-a8c4-3dd1a1820db1) from Safari on the registered iPhone.

- EAS reports `finished` at 10/17/2026 05:40:38 local time (cloud run ~6.5 minutes), app version `0.1.0`, build `21`, internal `preview` distribution.
- Source commit `c2a72e8` (built-in theme sets with light+dark palettes, the theme-set dropdown and deep cobalt navy darks) plus working-tree changes; iOS build number bumped from 20 to 21 for this build.
- Existing EAS-managed ad hoc signing and the registered iPhone provisioning profile were reused. Signed IPA HEAD returned 200 (26,831,501 bytes).
- Full details and receipts: [the build record](./builds/ios-preview-21.md).
- Physical installation and app behavior on the iPhone remain unverified.

Earlier builds and deployment feedback are preserved in the [installation history](../archived/docs/iphone-installation-history-2026-10-18.md).

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

## Verification

Build 21 compiled and was signed successfully; its [build record](builds/ios-preview-21.md) preserves the source and test boundaries. Physical installation, offline inference and on-phone workflows remain unverified. The [remaining work ledger](../plans/status/README.md) keeps these gates active.

For shared browser checks, follow the [local UI testing guide](local-ui-testing.md). Earlier export receipts, build failures and phone feedback are in the [installation history](../archived/docs/iphone-installation-history-2026-10-18.md).
