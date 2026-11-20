#!/usr/bin/env bash
# Builds an ad-hoc-signed, shareable Stenographer.app and zips it to dist/.
#
# Not notarized (no Developer ID): recipients must clear the quarantine flag (see OPEN-ME.txt in the zip).
# Version comes from the top-level VERSION file.
#
# Usage: bash Scripts/dist.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
DIST="$ROOT/dist"
DERIVED="$DIST/DerivedData"
APP="$DERIVED/Build/Products/Release/Stenographer.app"
WORKER="$APP/Contents/XPCServices/StenoWorker.xpc"

echo "=== Stenographer $VERSION ==="

echo "[1/5] Generating project"
(cd App && xcodegen generate >/dev/null)

echo "[2/5] Building (Release, unsigned)"
rm -rf "$DIST"
mkdir -p "$DIST"
xcodebuild -project App/Stenographer.xcodeproj -scheme Stenographer -configuration Release \
  -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" build >"$DIST/build.log" 2>&1 \
  || { tail -40 "$DIST/build.log"; exit 1; }
[ -d "$APP" ] && [ -d "$WORKER" ] || { echo "Build did not produce the app and worker"; exit 1; }

echo "[3/5] Stamping version"
for plist in "$APP/Contents/Info.plist" "$WORKER/Contents/Info.plist"; do
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $VERSION" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $VERSION" "$plist"
done

echo "[4/5] Signing (ad-hoc, inside-out)"
# Ad-hoc code has no Team ID, so hardened-runtime library validation would reject the embedded frameworks.
APP_ENT="$DIST/app.entitlements"
WORKER_ENT="$DIST/worker.entitlements"
cp App/Stenographer/Stenographer.entitlements "$APP_ENT"
/usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$APP_ENT"
cat > "$WORKER_ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>
PLIST
sign() { codesign --force --timestamp=none --options runtime -s - "$@"; }
while IFS= read -r -d '' fw; do sign "$fw"; done < <(find "$APP" -depth -name "*.framework" -type d -print0)
while IFS= read -r -d '' lib; do sign "$lib"; done < <(find "$APP" -name "*.dylib" -print0)
sign --entitlements "$WORKER_ENT" "$WORKER"
sign --entitlements "$APP_ENT" "$APP"

echo "[5/5] Verifying and packaging"
codesign --verify --deep --strict "$APP"
STAGE="$DIST/Stenographer"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
cat > "$STAGE/OPEN-ME.txt" <<'TXT'
Stenographer - how to open (not notarized)
==========================================

macOS Gatekeeper blocks apps that are not notarized. To open it:

1. Drag Stenographer.app into /Applications.
2. In Terminal, remove the quarantine flag, then open the app:

       xattr -dr com.apple.quarantine /Applications/Stenographer.app

   (Or double-click it, let it be blocked, then System Settings > Privacy & Security > Open Anyway.)

3. Allow Microphone access, and system audio recording when asked
   (System Settings > Privacy & Security > Screen & System Audio Recording).
   Each release is signed differently, so macOS asks again after you update.

4. The first launch downloads the speech models (about 1 GB). Notes generation
   can use a built-in model downloaded from Settings > AI.

Requirements: Apple Silicon Mac, macOS 26 or later. Audio and transcripts stay on your Mac.
TXT
ZIP="$DIST/Stenographer-$VERSION.zip"
(cd "$DIST" && ditto -c -k --sequesterRsrc --keepParent Stenographer "$ZIP")

echo "Zip: $ZIP"
