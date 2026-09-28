#!/usr/bin/env bash
set -euo pipefail

# Run physically on the Mac. This creates a local development build, not an EAS submission.
task_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'Run this script on your Mac with Xcode.' >&2
  exit 1
fi
for task_tool in node pnpm xcodebuild pod; do
  if ! command -v "$task_tool" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s. Ask your Mac administrator if installation is restricted.\n' "$task_tool" >&2
    exit 1
  fi
done
node --version
pnpm --version
xcodebuild -version
pod --version
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("LocalLab needs Node 22.13 or newer."); process.exit(1); }'
if [[ "${1:-}" == "--check" ]]; then
  printf '%s\n' 'Prerequisites found. No dependencies installed and no build started.'
  exit 0
fi
if [[ -n "${1:-}" ]]; then
  printf '%s\n' 'Usage: bash tools/run-iphone-local.sh [--check]' >&2
  exit 1
fi
cd "$task_repo_root"
pnpm install --frozen-lockfile
printf '%s\n' 'Unlock and connect your iPhone. Choose it in the device picker.'
pnpm --filter @locallab/mobile exec expo run:ios --device
