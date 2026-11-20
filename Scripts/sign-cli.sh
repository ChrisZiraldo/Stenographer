#!/usr/bin/env bash
# Builds `steno` and signs it with a stable identity so macOS privacy grants (microphone,
# system audio) survive rebuilds; ad-hoc signatures change on every link.
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG="${1:-debug}"
IDENTITY="${STENO_SIGN_IDENTITY:-Apple Development: chris.ziraldo@wbd.com (WZ8DCXAW58)}"
swift build -c "$CONFIG" --product steno
BIN="$(swift build -c "$CONFIG" --show-bin-path)/steno"
codesign --force --sign "$IDENTITY" --identifier com.ziraldo.steno "$BIN"
echo "$BIN"
