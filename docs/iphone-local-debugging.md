# Debug AI Chat on My Terms on your Mac and iPhone

Keep editing on Windows. Transfer the current source checkout to your Mac to build and examine native behavior. The Mac needs Node 22.13 or newer, pnpm 8.15.9, Xcode and CocoaPods. The source bundle includes the workspace packages and native compatibility patches; copying only `apps/mobile` is insufficient.

## First check

From the checkout root in the Mac terminal:

```bash
bash tools/run-iphone-local.sh --check
```

This reports available prerequisites without installing dependencies or building. If your Mac's restrictions prevent a prerequisite, use its approved installation process.

## Build and run

Connect and unlock the iPhone, enable Developer Mode, and run:

```bash
bash tools/run-iphone-local.sh
```

The script installs the pinned workspace dependencies and runs `expo run:ios --device`. Choose your phone. If signing asks for a team, choose your existing Apple Developer team in Xcode. This creates a development build locally; it does not submit an Expo cloud build.

The generated Xcode workspace is in `apps/mobile/ios`. Open its `.xcworkspace` file, select the iPhone, and use Xcode's Run and debug console for native logs and breakpoints. Expo's development server provides JavaScript updates and React Native debugging.

## Check the changed app

- Confirm the deep cobalt title bar is below the camera cutout and the composer remains visible when the keyboard opens. Extra chrome and the chat header/taskbar should collapse while typing; Hide keyboard in the title bar should restore them. Writing options should open in a separate dialog without moving the composer behind the taskbar.
- Change Appearance to Dark and Light, close/reopen the app, and check persistence.
- In Providers, add your PC at `http://192.168.1.213:35961/v1` (the **This PC** preset's address), allow local HTTP, and open Chat model. It should discover the model your local server currently has loaded. The phone needs access to the same private network and permission to access local devices.
- Save a provider, edit it, favorite it, and navigate to Voices and back. The current conversation should remain selected.
- In Voice Studio, use any already installed voice pack. Select a voice and speed, preview it, and Stop. Models and voices remain in this app's private storage; a separately installed development build may not have another build's downloads.
- For a download that appears stuck, share the exact visible phase and Xcode console output. The new code separates transfer from saving/unpacking and skips full model hash scans. No large model download is required merely to check the UI.

Browser exercises and the local iOS JavaScript export do not prove physical device behavior. The current Windows session cannot operate this Mac or iPhone remotely.

## Windows iteration after installation

If your phone can reach a Windows development server under your network policy, the installed development build can load its JavaScript changes. Native dependency changes require another native build. Keep PC model endpoints separate from the development server's address.

References: [Expo local development builds](https://docs.expo.dev/guides/local-app-development/), [Apple running on devices](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).
