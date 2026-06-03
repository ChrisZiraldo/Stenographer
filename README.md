# Stenographer

Local-first meeting transcription desktop app for macOS. All audio processing and speech recognition runs entirely on-device — nothing leaves your machine. Powered by **Parakeet TDT V3** (on-device ASR via WebGPU) and the **Cursor SDK** (AI notes generation).

Uses a **hybrid transcription strategy**: live VAD-driven subtitles during the session for real-time feedback, then a full high-quality re-transcription pass over the recorded audio when you hit Generate Notes — producing a more accurate final transcript and better meeting notes.

| Mode | How |
|---|---|
| **Zoom / app audio** | Route Zoom's speaker through BlackHole → select BlackHole as Input Device, enable Pass Through |
| **In-person meeting** | Select your microphone as Input Device, disable Pass Through |
| **Recorded file** | Drag a `.wav / .mp3 / .m4a / .flac / .ogg / .webm` onto the app |

After stopping, the app automatically generates structured meeting notes via a local Cursor agent.

---

## Requirements

- macOS 13+ on Apple Silicon (M1–M4)
- Node.js 18+
- [BlackHole 2ch](https://existential.audio/blackhole/) — only needed for Zoom/app audio capture
- Cursor API key from [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations)

---

## One-time setup

### 1 · Install BlackHole (Zoom mode only)

```bash
brew install blackhole-2ch
```

In Zoom: `Settings → Audio → Speaker → BlackHole 2ch`

The app handles pass-through monitoring internally so you still hear the call. No Aggregate Device or Multi-Output Device needed.

### 2 · Configure your API key

```bash
cp .env.example .env
# Edit .env and set CURSOR_API_KEY=cursor_...
```

### 3 · Install and start

```bash
npm install
npm start
```

The first launch downloads the Parakeet V3 model weights (~350 MB) from Hugging Face and caches them in IndexedDB. Subsequent launches are instant.

---

## Usage

### Live meeting

1. Open the app and wait for **Go** to become active (model is loading in the background).
2. Set **Input Device** → the audio source you want to transcribe (BlackHole for Zoom, your mic for in-person).
3. **Pass Through** — turn ON for Zoom (routes BlackHole audio back to your speakers so you can hear the call), OFF for in-person (prevents feedback).
   - When Pass Through is ON, select your speakers/headphones from the dropdown next to the toggle.
4. **Include my voice** — turn ON if you also want your own mic captured and labelled in the transcript. Select your microphone from the dropdown. Only available when Pass Through is ON.
5. Hit **Go**. Live subtitles appear as people speak.
6. Hit **Go** again (shows as *Pause*) when done.
7. Hit **Generate Notes** for the AI-written summary.

### Recorded file

Drag any audio file onto the app window (or click **Choose File**). The app decodes, transcribes, then generates notes automatically.

**Supported formats:** `.wav` `.mp3` `.m4a/.aac` `.flac` `.ogg` `.webm`

### Audio settings (EQ panel)

Click the equaliser icon (bottom-right) to open the audio settings flyout. All parameters update live, even mid-recording:

| Slider | What it controls | Range |
|---|---|---|
| **Sensitivity** | RMS threshold to trigger speech detection | 1 (loud only) → 10 (very quiet) |
| **Reactivity** | EMA smoothing coefficient — how fast the detector responds to volume changes | 1 (smooth) → 10 (instant) |
| **Min Speech** | Minimum duration a sound must be sustained before it's treated as speech | 1 (~30 ms) → 10 (~800 ms) |
| **Silence Gap** | How long silence must persist before a speech segment is sent for transcription | 1 (~100 ms) → 10 (~1500 ms) |

---

## Output files

```
recordings/
  transcript-2026-06-02_10-30-00.txt    ← enhanced transcript (replaced with high-quality pass on Generate Notes)
  meeting-notes-2026-06-02_10-30-00.md  ← structured AI notes
  recording-2026-06-02_10-30-00.wav     ← raw session audio (16 kHz mono, both streams mixed)
```

When **Include my voice** is active, your segments are prefixed with `[Me]` in the saved transcript so the notes model knows who said what.

Meeting notes contain:
- **Summary** — 3–5 sentences
- **Decisions** — things agreed on
- **Action Items** — owner · task · due date
- **Callouts / Risks** — flagged concerns
- **Open Questions** — unresolved questions

---

## Architecture

### Audio pipeline

```
┌─ Live recording ─────────────────────────────────────────────────────────────┐
│                                                                               │
│  Zoom / BlackHole ──► getUserMedia()                                          │
│                              │                                                │
│                   ┌──────────┴──────────────────────┐                        │
│                   │                                 │                        │
│             AudioWorklet                    <audio> setSinkId                │
│          (16 kHz mono PCM)               → Your speakers (pass-through)      │
│                   │                                                           │
│          ┌────────┴─────────────────┐                                        │
│          │                         │                                         │
│     mainRecBuffer             Energy VAD (mainVAD)                           │
│  (all frames saved)               │                                          │
│                            Parakeet → live subtitles                         │
│                                                                               │
│  MacBook Mic ──► getUserMedia()  (when "Include my voice" is on)             │
│                       │                                                       │
│            ┌──────────┴──────────────────────┐                               │
│            │                                 │                               │
│      myRecBuffer                    Energy VAD (myVAD, label="Me")           │
│   (all frames saved)                         │                               │
│                                       Parakeet → live subtitles              │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │  Generate Notes pressed
                                               ▼
┌─ Hybrid re-transcription ────────────────────────────────────────────────────┐
│                                                                               │
│  mainRecBuffer ──► concat Float32 ──► transcribeLongAudio (95 s chunks,      │
│                                         returnTimestamps, full context)       │
│                                       → chunks [ { text, timestamp } ]       │
│                                                                               │
│  myRecBuffer   ──► concat Float32 ──► transcribeLongAudio (same)             │
│                                       → chunks [ { text, timestamp, Me } ]   │
│                                                                               │
│  Mix both PCM ──► encodeWav ──► recordings/recording-*.wav                   │
│                                                                               │
│  Merge & sort chunks by timestamp[0] ──► enhanced transcript                 │
│  Replace live transcript panel                                                │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │
                                    @cursor/sdk Agent.prompt
                                    (Electron main process)
                                               │
                                    meeting-notes-*.md
```

```
Dropped audio file
   │
decodeAudioData + OfflineAudioContext (→ 16 kHz mono Float32)
   │
transcribeLongAudio (Parakeet, 95 s chunks, no re-transcription pass)
   │
same notes pipeline ↑
```

### Energy-based VAD

No external VAD library — the detector is a lightweight state machine running in the renderer process on every 10 ms AudioWorklet frame:

```
SILENCE ──[ smoothedRMS > SPEECH_RMS ]──► SPEAKING
           accumulate frames into buffer

SPEAKING ──[ smoothedRMS < SILENCE_RMS
             for ≥ SILENCE_HOLD_FRAMES    ]──► flush to Parakeet → SILENCE
          ──[ buffer ≥ MAX_SPEECH_FRAMES  ]──► hard flush (avoids GPU OOM)
```

Energy is tracked as an exponential moving average (EMA) of the per-frame RMS:

```
smoothedRMS = α × rms(frame) + (1 − α) × smoothedRMS
```

All five parameters (α, speech threshold, silence threshold, min speech duration, silence hold) are exposed via the EQ flyout and update live without restarting.

Each audio source (BlackHole stream, mic stream) gets its own independent VAD instance so they don't share state or interfere with each other.

### Dual stream / speaker labelling

When **Include my voice** is enabled the app opens a second `getUserMedia` stream for the microphone in parallel with the BlackHole stream. The mic stream is:
- Fed into its own AudioWorklet → VAD → Parakeet pipeline
- **Never** routed to the pass-through output (so you don't hear yourself back)
- Labelled `[Me]` in the transcript and `ME:` (purple) in the live UI

The BlackHole stream carries no label, so the transcript reads naturally as alternating unlabelled (others) and `[Me]` (you) segments.

### Pass-through monitoring

When Pass Through is enabled, a standard `<audio>` element is created with `srcObject` set to the BlackHole media stream. `setSinkId()` routes playback to the user's chosen output device. The AudioWorklet → silent gain node → `audioContext.destination` connection exists in parallel purely to keep Chromium's audio graph alive — without it, the worklet's `process()` method is never called (lazy graph optimisation in Electron's Chromium).

### Transcription engine

[parakeet.js](https://github.com/thatcherfreeman/parakeet.js) wraps NVIDIA's Parakeet TDT 0.6B V3 model:
- **Backend:** WebGPU (fp32 encoder) with automatic WASM fallback on unsupported hardware
- **Live mode:** `transcribeSegment()` on each VAD-flushed buffer (0.5–8 s)
- **File / re-transcription mode:** `transcribeLongAudio()` with 95 s overlapping chunks, `returnTimestamps: true` for chunk-level `[start, end]` timestamps used by the merge step
- Model weights are fetched from Hugging Face Hub on first run and cached in browser IndexedDB — no re-download on subsequent launches

### Hybrid re-transcription

During a live session the AudioWorklet frames are accumulated in two in-memory buffers (`mainRecBuffer` for the call stream, `myRecBuffer` for the mic stream) alongside the normal VAD pipeline. When Generate Notes is pressed:

1. Both buffers are concatenated into full Float32 arrays and passed to `transcribeLongAudio` with chunk timestamps.
2. The two sets of timestamped chunks are merged and sorted chronologically — mic chunks are tagged `[Me]`.
3. The mixed PCM (both streams summed) is WAV-encoded (16-bit PCM) and saved to `recordings/recording-*.wav`.
4. `currentTranscript` is replaced with the enhanced text before notes are generated.

Memory overhead: ~115 MB per stream per hour at 16 kHz mono Float32. The re-transcription pass runs at well under real-time on WebGPU.

### Notes generation

The Cursor SDK (`@cursor/sdk`) runs in the Electron main process (Node.js context). On session end, the full transcript is sent to a local Cursor agent with a structured prompt requesting Summary, Decisions, Action Items, Callouts/Risks, and Open Questions. The result is written to `recordings/meeting-notes-<timestamp>.md`. The transcript is also auto-saved with a 2-second debounce during recording so nothing is lost if the app crashes.

### Stack

| Layer | Technology |
|---|---|
| Shell | Electron 36 + Electron Forge |
| Bundler | Vite 6 |
| Audio capture | Web Audio API — `getUserMedia`, `AudioWorkletNode` |
| Downsampling | Custom AudioWorklet (linear interpolation, any rate → 16 kHz mono) |
| Speech recognition | parakeet.js 1.4 / Parakeet TDT 0.6B V3 (WebGPU) |
| Notes AI | @cursor/sdk (local Cursor agent) |
| IPC | Electron `contextBridge` / `ipcMain` |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No transcript / silence | Zoom speaker must be set to BlackHole. Check `Zoom → Settings → Audio → Speaker`. |
| Transcript only captures others, not me | Enable **Include my voice** and select your microphone. |
| `Microphone error` | Grant mic access: `System Settings → Privacy → Microphone → Stenographer` |
| Model download stalls | Check network and retry. Cache lives in browser IndexedDB (DevTools → Application → IndexedDB). |
| Notes not generated | Check `CURSOR_API_KEY` in `.env` — must start with `cursor_`. |
| Transcript cuts off mid-sentence | Lower **Silence Gap** in the EQ panel so segments flush sooner. |
| Background noise triggers transcription | Raise **Min Speech** and lower **Sensitivity** in the EQ panel. |
| Quiet voices not captured | Raise **Sensitivity** in the EQ panel (try 7–8). |
