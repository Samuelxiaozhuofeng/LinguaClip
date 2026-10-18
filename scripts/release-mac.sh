#!/bin/bash
# Builds both Mac apps for a GitHub Release into src-tauri/target/release-files/:
# LinguaClip-mac-apple-silicon.zip and LinguaClip-mac-intel.zip, plus each one's
# signed one-click-update package (.app.tar.gz + .sig, docs/update.md) when the
# updater key is on this machine. Run on an Apple-silicon Mac: the Intel app is
# cross-compiled here (rustup target add x86_64-apple-darwin, done below), not on GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -m)" = arm64 ] || { echo "run this on an Apple-silicon Mac"; exit 1; }
KEY="$HOME/.tauri/linguaclip-updater.key"
rustup target add x86_64-apple-darwin
OUT=src-tauri/target/release-files
# Start empty: a file left from an earlier run must not pass as this version's.
rm -rf "$OUT"
mkdir -p "$OUT"

# build <arch name> <bundle folder> [tauri build args...]
build() {
  local arch=$1 bundle=$2; shift 2
  if [ -f "$KEY" ]; then
    TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
      npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":true}}' "$@"
  else
    npx tauri build --bundles app "$@"
  fi
  ditto -c -k --keepParent "$bundle/LinguaClip.app" "$OUT/LinguaClip-mac-$arch.zip"
  if [ -f "$KEY" ]; then
    cp "$bundle/LinguaClip.app.tar.gz" "$OUT/LinguaClip-mac-$arch.app.tar.gz"
    cp "$bundle/LinguaClip.app.tar.gz.sig" "$OUT/LinguaClip-mac-$arch.app.tar.gz.sig"
  fi
}

build apple-silicon src-tauri/target/release/bundle/macos
build intel src-tauri/target/x86_64-apple-darwin/release/bundle/macos --target x86_64-apple-darwin
lipo -archs src-tauri/target/x86_64-apple-darwin/release/bundle/macos/LinguaClip.app/Contents/MacOS/linguaclip | grep -qx x86_64
ls -l "$OUT"
