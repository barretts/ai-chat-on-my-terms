# Mobile dev loop (no build per change)

Goal: JS/asset changes reach the iPhone in seconds; full builds (EAS cloud or the
Mac) are only needed when native code, `app.json` config, or a dependency with
native code changes.

The pieces are already in the repo: `expo-dev-client` (57.0.20) is a dependency,
`apps/mobile` `main` is `expo-router/entry`, `start` runs
`expo start --dev-client`, and `eas.json` has a `development` profile
(`developmentClient: true`).

## 1. One-time: build the dev client on the MacBook

```sh
git pull                                   # main, clean tree
cd apps/mobile
pnpm exec expo run:ios --configuration Debug --device \
  --scheme locallab                        # builds + installs on the connected iPhone
```

No `eas login` is involved for this path — Xcode signs locally. Alternatively
`pnpm dlx eas-cli@24.8.0 build --profile development --platform ios --local`
uses the same credentials as preview builds and produces an installable artifact.

Do NOT build the dev client with the `preview` profile: preview has
`developmentClient: false` and production-like env baked in, which defeats the
loop.

## 2. Daily loop (Windows box, nothing plugged in)

```sh
cd apps/mobile && unset CI && pnpm mobile:start
```

- `unset CI` matters: with `CI=true` Metro starts in CI mode with reloads
  disabled ("Metro is running in CI mode, reloads are disabled" appears at
  startup — if you see it, restart without CI).
- The iPhone must be on the same LAN as the PC and have opened the dev-launcher
  QR/deep link once (dev client remembers the packager host). If the phone
  can't reach the PC, Windows Defender may be blocking inbound node on port
  8081; allow it for Private networks or use USB (dev client works over USB
  via Metro on the host advertised with `--localhost` + `adb`-free iOS USB
  tunnelling handled by `expo run`).
- Save a file → the app reloads with the change in ~2–5 s. No EAS, no quota.

## 3. Model server for the loop

The dev client reads `apps/mobile/.env` (`EXPO_PUBLIC_STRATA_*`). The committed
`.env` contains only the API key; on a phone `127.0.0.1` points at the phone,
not the PC. Either set the LAN values in `.env` before starting Metro:

```
EXPO_PUBLIC_STRATA_BASE_URL=http://192.168.1.213:1234/v1
EXPO_PUBLIC_STRATA_MODEL_ID=qwen3.8-flash-next-iq3_s-128k
```

screens (they accept any OpenAI-compatible URL; this is what the web UI tests
do).

## 4. When a rebuild IS required

- `apps/mobile/app.json` (entitlements, Info.plist, plugins) or Podfile/
  native module changes (llama.rn, expo-sqlite, downloads) → rebuild the dev
  client (step 1) — and release proof still needs a `preview` build.
- Anything under `app/`, `features/`, `composition/`, `packages/*`,
  `assets/`: Metro serves it. Assets hot-reload from the bundler, but
  `expo-sqlite` seeded rows persist in the dev app — wipe app data on the
  phone when starter-pack/marker behavior is under test.

## 5. Verified state (2026-10-22)

- `expo start --dev-client --port 8082` (SDK 57.0.30) served
  `GET /node_modules/expo-router/entry.bundle?platform=ios&dev=true&hot=false&lazy=true`
  → HTTP 200, 11,947,316 bytes, valid Hermes dev bundle (`__DEV__=true`) in
  20.5 s on a warm cache. That is the exact artifact the dev client requests,
  so the phone-side loop is limited only by network + reload, not compilation.
