#!/usr/bin/env bash
# Generates deterministic speech fixtures into v2/Fixtures/generated/.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="Fixtures/generated"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

S1="The quarterly numbers look strong. We should ship the new onboarding flow next sprint."
D1="I agree, but the payment migration is a risk. Let's assign Priya to review it by Friday."
S2="Great, I will update the roadmap today."
D2="Thanks, I will send the notes after the call."

speak() { # voice text out.wav
    say -v "$1" -o "$TMP/$(basename "$3" .wav).aiff" "$2"
    afconvert -f WAVE -d LEI16@16000 -c 1 "$TMP/$(basename "$3" .wav).aiff" "$3"
}

speak Samantha "$S1" "$OUT/samantha.wav"
speak Daniel "$D1" "$OUT/daniel.wav"
speak Samantha "$S2" "$TMP/samantha2.wav"
speak Daniel "$D2" "$TMP/daniel2.wav"

python3 - "$OUT" "$TMP" "$S1" "$D1" "$S2" "$D2" <<'PY'
import json, sys, wave
out, tmp, s1, d1, s2, d2 = sys.argv[1:7]
RATE = 16000
pieces = [("A", f"{out}/samantha.wav", s1), ("B", f"{out}/daniel.wav", d1),
          ("A", f"{tmp}/samantha2.wav", s2), ("B", f"{tmp}/daniel2.wav", d2)]
silence = b"\x00\x00" * RATE
frames, spans, pos = [], [], 0
for i, (spk, path, _) in enumerate(pieces):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2
        n = w.getnframes()
        frames.append(w.readframes(n))
    spans.append({"speaker": spk, "start": round(pos / RATE, 3), "end": round((pos + n) / RATE, 3)})
    pos += n
    if i < len(pieces) - 1:
        frames.append(silence)
        pos += RATE
with wave.open(f"{out}/two-speakers.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
    w.writeframes(b"".join(frames))
with open(f"{out}/two-speakers.txt", "w") as f:
    f.write("\n".join(p[2] for p in pieces) + "\n")
with open(f"{out}/two-speakers.rttm-like.json", "w") as f:
    json.dump(spans, f, indent=2)
print(f"two-speakers.wav: {pos / RATE:.2f}s, spans: {spans}")
PY
