#!/usr/bin/env bash
# Manual capture check: records <mode> into <dir> while running <cmd>, then stops with SIGINT and
# prints recorded vs wall duration. Usage: capture-check.sh <mode> <dir> <seconds-after-cmd> <cmd...>
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="$1" DIR="$2" TAIL="$3"
shift 3
BIN=.build/debug/steno
rm -rf "$DIR"
"$BIN" record --mode "$MODE" --out "$DIR" > "$DIR.log" 2>&1 &
until grep -q partStarted "$DIR.log" 2>/dev/null; do sleep 0.05; done
T0=$(python3 -c 'import time; print(time.time())')
sleep 1
"$@"
sleep "$TAIL"
kill -INT $!
T1=$(python3 -c 'import time; print(time.time())')
wait $! || true
grep -v '^levels' "$DIR.log"
python3 -c "print(f'wall since first audio: {$T1 - $T0:.2f}s')"
"$BIN" finalize "$DIR"
