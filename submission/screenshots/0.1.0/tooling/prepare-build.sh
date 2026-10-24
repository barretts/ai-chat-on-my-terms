#!/usr/bin/env bash
set -euo pipefail
# Run on the Mac hosting Xcode. All generated native files stay in this temporary workspace.
task_repo_root="$(git rev-parse --show-toplevel)"
task_build_root="${1:?Usage: prepare-build.sh <new-temporary-build-directory>}"
if [[ -e "$task_build_root" ]]; then
  printf '%s\n' 'Choose a new temporary directory; existing builds are preserved.' >&2
  exit 1
fi
cd "$task_repo_root"
pnpm install --frozen-lockfile
mkdir -p "$task_build_root/source"
rsync -a --exclude=.git --exclude=node_modules --exclude=ios --exclude=android \
  --exclude=.logs --exclude=.expo --exclude=dist --exclude=target --exclude=build --exclude=submission/screenshots \
  --exclude=.env --exclude='.env.*' \
  "$task_repo_root/" "$task_build_root/source/"
python3 - "$task_repo_root" "$task_build_root/source" <<'PY'
import os
import sys
from pathlib import Path
source, destination = map(Path, sys.argv[1:])
for directory, children, _ in os.walk(source):
    children[:] = [name for name in children if name not in ('.git', 'Pods', 'target', 'ios', 'android', '.logs')]
    if 'node_modules' in children:
        children.remove('node_modules')
        dependencies = Path(directory) / 'node_modules'
        link = destination / dependencies.relative_to(source)
        if link.parent.exists():
            link.symlink_to(dependencies, target_is_directory=True)
PY
cd "$task_build_root/source/apps/mobile"
EXPO_NO_TELEMETRY=1 EXPO_NO_DOTENV=1 APP_STORE_BUILD=1 \
  node node_modules/expo/bin/cli prebuild --platform ios --no-install
cd ios
env -u GEM_HOME -u GEM_PATH pod install
# Workspace dependencies link to the original source. Keep Metro's workspace-relative resolution intact.
printf 'export NODE_BINARY=%q\nexport PROJECT_ROOT=%q\n' \
  "$(command -v node)" "$task_repo_root/apps/mobile" > .xcode.env.local
EXPO_NO_TELEMETRY=1 EXPO_NO_DOTENV=1 APP_STORE_BUILD=1 \
  xcodebuild -workspace AIChatonMyTerms.xcworkspace -scheme AIChatonMyTerms \
  -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$task_build_root/DerivedData" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=KQJWD7GN74
