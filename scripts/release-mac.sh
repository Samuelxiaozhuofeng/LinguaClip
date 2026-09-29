#!/bin/bash
# Builds this Mac's app for a GitHub Release into src-tauri/target/release-files/:
# LinguaClip-mac-<arch>.zip, plus the signed one-click-update package
# (.app.tar.gz + .sig, docs/update.md) when the updater key is on this machine.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH=$([ "$(uname -m)" = arm64 ] && echo apple-silicon || echo intel)
KEY="$HOME/.tauri/linguaclip-updater.key"
if [ -f "$KEY" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":true}}'
else
  npx tauri build --bundles app
fi
OUT=src-tauri/target/release-files
BUNDLE=src-tauri/target/release/bundle/macos
mkdir -p "$OUT"
ditto -c -k --keepParent "$BUNDLE/LinguaClip.app" "$OUT/LinguaClip-mac-$ARCH.zip"
if [ -f "$KEY" ]; then
  cp "$BUNDLE/LinguaClip.app.tar.gz" "$OUT/LinguaClip-mac-$ARCH.app.tar.gz"
  cp "$BUNDLE/LinguaClip.app.tar.gz.sig" "$OUT/LinguaClip-mac-$ARCH.app.tar.gz.sig"
fi
ls -l "$OUT"
