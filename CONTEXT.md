# Stenographer — Session Context Summary

This file captures the full development history and current state of the project so context can be restored after moving the project directory.

---

## Project

**Name:** Stenographer (formerly Meeting Transcriber)  
**Location:** `/Users/chris.ziraldo/Desktop/Transcribe`  
**Stack:** Electron 36 + Vite 6 + parakeet.js + @cursor/sdk  
**Run:** `npm start`

---

## What this app does

Local-first meeting transcription desktop app for macOS. Everything runs on-device.

- Captures audio from BlackHole (Zoom) and/or your microphone
- Live transcription via Parakeet TDT V3 (WebGPU, on-device)
- On "Generate Notes": re-transcribes the full recorded session at higher quality, saves a `.wav`, then generates structured AI meeting notes via the Cursor SDK
- Three modes: Zoom/app audio, in-person mic, recorded file (drag-and-drop)

---

## Key files

| File | Purpose |
|---|---|
| `src/renderer/renderer.js` | Main renderer — audio capture, VAD, recording buffers, hybrid re-transcription, UI logic |
| `src/renderer/transcription.js` | Wraps parakeet.js — `transcribeSegment`, `transcribeFile`, `transcribeFileTimestamped` |
| `src/renderer/audio-processor.js` | AudioWorklet — downsamples to 16 kHz mono Float32, posts 10 ms frames |
| `src/renderer/file-import.js` | Decodes dropped audio files to 16 kHz mono Float32 via Web Audio API |
| `src/renderer/index.html` | Full UI — styles, layout, all HTML |
| `src/main.js` | Electron main process — window, IPC handlers (save-transcript, save-audio, generate-notes) |
| `src/preload.js` | contextBridge — exposes `window.api.saveTranscript`, `saveAudio`, `generateNotes` |
| `src/generate-notes.cjs` | Child process script — calls @cursor/sdk to generate meeting notes |
| `src/notes-prompt.js` | Builds the structured notes prompt sent to the Cursor agent |
| `.env` | `CURSOR_API_KEY` — required for notes generation |

---

## Architecture

### Audio pipeline (live)

1. `getUserMedia` opens the input device (BlackHole or mic)
2. An `AudioWorkletNode` (`audio-downsample-processor`) downsamples to 16 kHz mono and posts 10 ms Float32 frames
3. Each frame is pushed into `mainRecBuffer` (or `myRecBuffer` for the mic stream) **and** fed into the energy VAD
4. VAD state machine (EMA RMS) detects speech segments and flushes them to `engine.transcribeSegment()` → live subtitles
5. A silent gain node connects the worklet to `audioContext.destination` to prevent Chromium's lazy graph optimisation from skipping the worklet

### Hybrid re-transcription (on Generate Notes)

1. `mainRecBuffer` + `myRecBuffer` (accumulated 16 kHz frames) are concatenated into full Float32 arrays
2. Both are re-transcribed via `engine.transcribeFileTimestamped()` — uses `transcribeLongAudio` with `returnTimestamps: true` and 95 s overlapping chunks
3. Chunks from both streams are merged and sorted by `timestamp[0]`, mic chunks tagged `[Me]`
4. Both PCM streams are mixed and WAV-encoded (16-bit PCM) → `recordings/recording-<ts>.wav`
5. `currentTranscript` is replaced with the enhanced text, then `finishSession()` saves the transcript and calls the Cursor SDK for notes

### Dual stream / speaker labelling

- When "Include my voice" is ON: a second `getUserMedia` stream opens for the mic; it has its own VAD instance (`myVAD`, label `'Me'`) and its own recording buffer (`myRecBuffer`)
- The mic stream is **never** routed to the pass-through output
- Live transcript shows `ME:` in purple (`<span class="speaker-me">`) before mic segments
- Saved transcript uses `[Me]` prefix

### VAD

Energy-based, no external library. Per-stream VAD objects created by `createVAD(label)`. Parameters (all adjustable live via EQ panel):
- `SPEECH_RMS` — threshold to enter speaking state
- `SILENCE_RMS` — threshold to return to silence (65% of SPEECH_RMS)
- `SMOOTH_ALPHA` — EMA coefficient
- `MIN_SPEECH_FRAMES` — minimum frames before a sound counts as speech
- `SILENCE_HOLD_FRAMES` — silence duration before flushing segment
- Hard flush at 8 s regardless

---

## UI layout

Vertical form — label (130px fixed) + control(s):

```
INPUT DEVICE      [BlackHole 2ch ▼]
PASS THROUGH      [●]  [MacBook Speakers ▼]
INCLUDE MY VOICE  [●]  [MacBook Mic ▼]

[         Go          ]  ← full-width rectangular button, dull green (#3f9168)

[status bar]
[subtitle area]
[transcript panel]
[drop zone] [Choose File] [EQ button ≡]
```

**EQ flyout panel** (slides in from right, triggered by the equaliser icon):
- Sensitivity (1–10) → SPEECH_RMS
- Reactivity (1–10) → SMOOTH_ALPHA
- Min Speech (1–10) → MIN_SPEECH_FRAMES
- Silence Gap (1–10) → SILENCE_HOLD_FRAMES

**Pass Through** toggle rules:
- OFF → output dropdown disabled, "Include my voice" row fully disabled (greys out, pointer-events none)
- ON, Include my voice OFF → row interactive but label stays bright, select dimmed via `select:disabled`
- ON, Include my voice ON → everything active

---

## Output files

All saved to `recordings/`:
- `transcript-<timestamp>.txt` — enhanced transcript (replaced by high-quality pass on Generate Notes)
- `meeting-notes-<timestamp>.md` — AI notes (Summary, Decisions, Action Items, Callouts/Risks, Open Questions)
- `recording-<timestamp>.wav` — mixed session audio (16 kHz mono, 16-bit PCM)

---

## Changes made this session (chronological)

1. Renamed "Hear it" toggle → "Pass through audio" → "Pass through"
2. Moved Go button below dropdowns, made it rectangular
3. Dulled green (#22c55e → #3f9168)
4. Added EQ flyout panel with 4 VAD sliders
5. Moved EQ button to bottom bar
6. Fixed AudioWorklet bug: connected workletNode through a silent gain to destination (Chromium lazy graph fix)
7. Added "Include my voice" feature: second mic stream, separate VAD, `[Me]` speaker labelling in transcript
8. Pass Through toggle disables/enables "Include my voice" row
9. Redesigned controls as vertical form layout (label + control rows)
10. Various label/disabled state polish (opacity, CSS cascade fixes)
11. Hybrid record + re-transcribe: recording buffers, `transcribeFileTimestamped`, `enhanceTranscript`, WAV save, IPC plumbing
12. Renamed project to Stenographer

---

## Known good state

- `npm start` works
- No linter errors in any source file
- `.env` has a valid `CURSOR_API_KEY`
- BlackHole 2ch must be installed for Zoom mode: `brew install blackhole-2ch`

---

## Environment

- macOS Apple Silicon (M1–M4)
- Node.js 18+
- Cursor API key in `.env` (starts with `cursor_`)
