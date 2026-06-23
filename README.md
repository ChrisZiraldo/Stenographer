![Stenographer](assets/logo.png)

# Stenographer

A local-first, notes-first meeting companion for macOS. Write notes while you meet, record and transcribe the conversation, then let AI merge everything into polished meeting notes. Transcription runs fully on-device — your audio never leaves your machine. The Generate step sends your notes and transcript to Cursor's AI to produce the final polished output.

Powered by **Parakeet TDT V3** (on-device speech recognition via WebGPU/WASM) and the **Cursor SDK** (AI notes generation).

---

## Features

### Notes library
- Browsable, searchable history of all notes grouped by date (Today, Yesterday, This week, etc.)
- **Spaces** — organise notes into custom-labelled buckets (Work, 1:1, Standup, etc.) with custom icons and colours; drag a note onto a space to tag it
- **Star** any note to pin it to the top of the list
- Full-text search across titles, note body, and transcripts
- Blank notes are automatically discarded when you navigate away

### Note editor (My Notes)
- **TipTap** rich-text editor with a formatting toolbar — bold, italic, underline, headings, lists, blockquotes, dividers, task checkboxes
- **Slash commands** — type `/` anywhere to insert blocks or trigger AI actions (clean up, summarise, extract action items)
- **Templates** — quickly pre-fill a note structure (standup, retro, 1:1, etc.)
- **Dictation** — push-to-talk mic button at the bottom of the editor sends audio through the on-device Parakeet model and inserts the transcribed text at your cursor, completely independent of the meeting recording pipeline
- Notes auto-save to SQLite as you type

### Recording & transcription
- **Live VAD-driven subtitles** — energy-based voice-activity detection runs in an AudioWorklet; detected speech chunks are flushed to Parakeet for real-time captions
- **Hybrid re-transcription** — full audio buffers are saved in memory during recording; when you hit Generate, a higher-quality full-context pass is run over the whole session, producing a much more accurate final transcript
- **Dual-stream capture** — optionally capture both the call audio (via BlackHole) and your own microphone simultaneously, with each stream labelled separately (`[Me]`)
- **Pass-through monitoring** — route BlackHole audio back to your speakers/headphones so you still hear the call while it's being captured
- **File import** — drag a `.wav / .mp3 / .m4a / .flac / .ogg / .webm` file onto the app to transcribe a recording after the fact
- **WebGPU → WASM fallback** — if the GPU is out of memory, the model automatically retries with WASM (CPU) so transcription still works

### AI generation
- **Generate** merges your handwritten notes with the full transcript using the Cursor SDK to produce clean, structured meeting notes
- **Live summary** (optional) — rolling AI summary updates every N seconds while recording, shown in the right pane alongside the live transcript
- Right pane is only shown when live transcription or live summary is enabled in settings

### Organisation
- **Spaces** — built-in (Work, 1:1, Standup, Planning, Interview, Review) plus unlimited custom spaces with an icon + colour picker
- Drag notes onto a sidebar space to apply a tag, or use the inline space tag strip inside a note
- Drag spaces to reorder them in the sidebar
- Right-click a note in a space to remove it from that space

### Appearance & settings
- **Dark mode** toggle in Settings (warm dark palette, not harsh grey)
- Compact **Settings dialog** with three panels: Audio, Processing, Voice Detection
- All VAD parameters adjust live without restarting a recording

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

### Starting a note

1. Click **+ New note** in the Library to open a blank note.
2. Give it a title and start typing in the **My Notes** editor.
3. Use `/` to insert blocks or trigger AI actions inline.

### Recording a meeting

1. Open a note (new or existing).
2. Open **Settings** (gear icon in the top bar) and configure your audio devices:
   - Set **Input** to BlackHole for Zoom, or your microphone for in-person.
   - Enable **Pass-through** if capturing Zoom audio so you can still hear the call.
   - Enable **Include my voice** to also capture and label your own microphone.
3. Hit **Record**. Live captions appear in the right pane (if Live Transcription is on).
4. Keep taking notes in the left pane while the call is being captured.
5. Hit **Record** again to stop.
6. Hit **Generate** to run the AI merge of your notes + transcript.

### Dictation (personal notes)

Tap the **microphone pill** at the bottom of the My Notes editor to start dictating. Speak naturally, then tap again to stop. The on-device Parakeet model transcribes your speech and inserts it at the cursor. This is independent of the meeting recording — no audio is saved.

### Recording from a file

Drag any supported audio file onto the app window. The app decodes, transcribes, then prompts you to enhance.

**Supported formats:** `.wav` `.mp3` `.m4a/.aac` `.flac` `.ogg` `.webm`

### Starring notes

Click the **star icon** on hover in the Library list, or the star in the note's top bar. Starred notes sort to the top of the list.

### Organising with Spaces

- Click a space in the sidebar to filter the list to notes tagged with that space.
- Drag any note row onto a space to tag it.
- Click **+** next to the Spaces heading to create a custom space — choose an icon, colour, and name.
- Hover a note inside a space to reveal the **tag icon** — click it to remove the note from that space.
- Drag spaces by their grip handle to reorder them.
- Long-hover a space name to reveal the delete option.

---

## Settings reference

### Audio

| Setting | Description |
|---|---|
| Input / BlackHole | The audio input device to record from |
| Pass-through to speakers | Route the input back to your output device so you can hear it |
| Output | Which speaker/headphone to send the pass-through to |
| Include my voice | Open a second mic stream and label your voice `[Me]` |
| My Mic | The microphone device for the second stream |

### Processing

| Setting | Description |
|---|---|
| Dark mode | Switch between warm light and dark themes |
| Live transcription | Show real-time captions in the right pane while recording |
| Live summary | Generate a rolling AI summary while recording |
| Summary interval | How often (in seconds) the live summary updates |

### Voice Detection

All parameters update live without restarting a recording.

| Slider | What it controls |
|---|---|
| **Sensitivity** | RMS threshold to trigger speech detection — raise for loud rooms, lower for quiet speakers |
| **Reactivity** | EMA smoothing — higher is snappier but more jittery |
| **Min speech** | Minimum duration a sound must be sustained before it's treated as speech |
| **Silence gap** | How long silence must persist before a speech segment is sent for transcription |

---

## Architecture

### Stack

| Layer | Technology |
|---|---|
| Shell | Electron 36 + Electron Forge 7 |
| UI | React 18 + Tailwind CSS v4 |
| Bundler | Vite 6 |
| Editor | TipTap 3 (StarterKit, TaskList, Underline, Placeholder) |
| State | Zustand 5 |
| Persistence | better-sqlite3 (SQLite, main process) |
| Audio capture | Web Audio API — `getUserMedia`, `AudioWorkletNode` |
| Downsampling | Custom AudioWorklet (linear interpolation, any rate → 16 kHz mono) |
| Speech recognition | parakeet.js 1.4 / Parakeet TDT 0.6B V3 (WebGPU with WASM fallback) |
| Notes AI | @cursor/sdk (Cursor agent, main process) |
| IPC | Electron `contextBridge` / `ipcMain` |

### Database schema (SQLite)

```
meetings          — id, title, created_at, status, tags, starred, folder_path …
notes             — meeting_id, human_doc_json, human_doc_text, summary_md, enhanced_md
transcript_segments — id, meeting_id, speaker, text, start_ms, end_ms
todos             — id, meeting_id, text, done, source ('human' | 'ai')
spaces            — name, icon, color, bg, sort_order
meetings_fts      — FTS5 virtual table for full-text search
```

### Audio pipeline

```
┌─ Live recording ──────────────────────────────────────────────────────────────┐
│                                                                                │
│  Zoom / BlackHole ──► getUserMedia()                                           │
│                              │                                                 │
│                   ┌──────────┴──────────────────────┐                         │
│                   │                                 │                         │
│             AudioWorklet                    <audio> setSinkId                 │
│          (16 kHz mono PCM)               → Your speakers (pass-through)       │
│                   │                                                            │
│          ┌────────┴─────────────────┐                                         │
│          │                         │                                          │
│     mainRecBuffer             Energy VAD (mainVAD)                            │
│  (all frames saved)               │                                           │
│                            Parakeet → live captions (right pane)              │
│                                                                                │
│  MacBook Mic ──► getUserMedia()  (when "Include my voice" is on)              │
│                       │                                                        │
│            ┌──────────┴──────────────────────┐                                │
│            │                                 │                                │
│      myRecBuffer                    Energy VAD (myVAD, label="Me")            │
│   (all frames saved)                         │                                │
│                                       Parakeet → live captions               │
└──────────────────────────────────────────────┬───────────────────────────────┘
                                               │  Generate pressed
                                               ▼
┌─ Hybrid re-transcription ─────────────────────────────────────────────────────┐
│                                                                                │
│  mainRecBuffer ──► concat Float32 ──► transcribeLongAudio (95 s chunks,       │
│                                         returnTimestamps, full context)        │
│                                       → chunks [ { text, timestamp } ]        │
│                                                                                │
│  myRecBuffer   ──► concat Float32 ──► transcribeLongAudio (same)              │
│                                       → chunks [ { text, timestamp, Me } ]    │
│                                                                                │
│  Merge & sort by timestamp ──► generated transcript                            │
│  Mix PCM ──► encodeWav ──► recordings/<timestamp>/recording.wav               │
└──────────────────────────────────────────────┬───────────────────────────────┘
                                               │
                                    @cursor/sdk Agent.prompt
                                    (Electron main process)
                                               │
                                    Streamed into Generated Notes tab
```

### Energy-based VAD

No external VAD library. A lightweight state machine runs in the renderer on every 10 ms AudioWorklet frame:

```
SILENCE ──[ smoothedRMS > SPEECH_RMS ]──► SPEAKING
           accumulate frames into buffer

SPEAKING ──[ smoothedRMS < SILENCE_RMS
             for ≥ SILENCE_HOLD_FRAMES    ]──► flush to Parakeet → SILENCE
          ──[ buffer ≥ MAX_SPEECH_FRAMES  ]──► hard flush (avoids GPU OOM at ~8 s)
```

Energy is tracked as an EMA of the per-frame RMS: `smoothedRMS = α × rms(frame) + (1 − α) × smoothedRMS`

Each audio source (BlackHole stream, mic stream) gets its own independent VAD instance.

### Transcription engine

[parakeet.js](https://github.com/thatcherfreeman/parakeet.js) wraps NVIDIA's Parakeet TDT 0.6B V3 model:
- **Live mode:** `transcribeSegment()` on each VAD-flushed buffer (0.5–8 s)
- **Batch mode:** `transcribeLongAudio()` with 95 s overlapping chunks, `returnTimestamps: true` for the hybrid merge step
- **Dictation mode:** same `transcribeSegment()` on a push-to-talk buffer, result inserted directly into the TipTap editor
- Model weights are fetched from Hugging Face Hub on first run and cached in IndexedDB — no re-download on subsequent launches
- **WebGPU → WASM fallback:** if the GPU session fails to allocate (e.g. low VRAM), the model retries automatically with WASM (CPU), trading speed for reliability

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No transcript / silence | Zoom speaker must be set to BlackHole. Check `Zoom → Settings → Audio → Speaker`. |
| Transcript only captures others, not me | Enable **Include my voice** in Settings and select your microphone. |
| `Microphone error` | Grant mic access: `System Settings → Privacy → Microphone → Stenographer` |
| Model download stalls | Check network and retry. Cache lives in IndexedDB (DevTools → Application → IndexedDB). |
| Notes not generated | Check `CURSOR_API_KEY` in `.env` — must start with `cursor_`. |
| Transcript cuts off mid-sentence | Lower **Silence gap** in Settings so segments flush sooner. |
| Background noise triggers transcription | Raise **Min speech** and lower **Sensitivity** in Settings. |
| Quiet voices not captured | Raise **Sensitivity** in Settings (try 7–8). |
| `std::bad_alloc` in console | GPU out of memory — close other GPU-heavy apps and restart. The app will fall back to WASM automatically if WebGPU fails. |
| Dictation mic button does nothing | The Parakeet model must be loaded first. Open a note and wait for the model initialisation to complete (progress bar at top). |
