# Stenographer

A native macOS app that records meetings, transcribes them locally, labels who said what, and turns them into notes. Audio is processed on-device; nothing leaves your Mac unless you point note generation at a remote LLM.

- **Capture:** system audio through Core Audio process taps plus your microphone, written continuously to crash-safe 16 kHz WAV parts with sample-aligned timing. Device changes and sleep start a new part; a crash is repaired on next launch.
- **Transcription:** Parakeet TDT 0.6B v3 via [FluidAudio](https://github.com/FluidInference/FluidAudio) (Core ML / Neural Engine). Live captions while recording.
- **Speakers:** pyannote community-1 diarization. Name a speaker once and choose "Remember this voice"; later meetings are labelled automatically. A People panel lists everyone with their meeting history.
- **Notes:** your own notes plus AI-generated notes from templates, using Apple's on-device model or any OpenAI-compatible endpoint (Ollama, LM Studio, cloud). Markdown export.
- **Isolation:** speech models run in an XPC worker, so a model crash never takes down a recording.

## Requirements

macOS 26, Apple Silicon, Xcode 27 / Swift 6.4, [xcodegen](https://github.com/yonaskolb/XcodeGen). The first run downloads about 1 GB of speech models from Hugging Face.

## Build and run

```sh
swift build && swift test            # core libraries and the `steno` CLI

cd App && xcodegen generate && cd ..
xcodebuild -project App/Stenographer.xcodeproj -scheme Stenographer \
  -configuration Release -derivedDataPath .build/xcode build
open .build/xcode/Build/Products/Release/Stenographer.app
```

`App/project.yml` sets the signing team and identity; change them to yours. A stable signature is needed for the system-audio permission to persist.

Tests that need downloaded models run with `STENO_MODEL_TESTS=1 swift test` after `Scripts/make-fixtures.sh`.

## Permissions

Microphone, and System Audio Recording under System Settings → Privacy & Security → Screen & System Audio Recording. The onboarding sheet walks through both. For the `steno` CLI the prompt is attributed to the terminal app that launched it.

## CLI

`steno` exposes every stage: `devices`, `record`, `recover`, `finalize`, `import`, `transcribe`, `diarize`, `process`, `notes` and `import-v1`. Run `steno --help`. Build it signed with `Scripts/sign-cli.sh`, and use `Scripts/capture-check.sh` for a timed system-audio capture check.

## Data

Everything lives in `~/Library/Application Support/Stenographer2/`: a SQLite index plus one folder per session (manifest, audio, transcripts). The manifest is the source of truth for capture; the database is an index that startup recovery rebuilds.

## Layout

| Path | Contents |
|---|---|
| `Sources/StenoModel` | Shared types, manifest IO |
| `Sources/StenoAudio` | Capture engine, WAV storage, finalize, import |
| `Sources/StenoPipeline` | ASR, diarization, transcript merge, live captions |
| `Sources/StenoStore` | SQLite store, job queue, recovery, speaker library, v1 importer |
| `Sources/StenoNotes` | LLM providers, templates, note generation |
| `Sources/StenoXPC` | App/worker XPC protocols |
| `Sources/steno` | CLI |
| `App/` | SwiftUI app and XPC worker (xcodegen project) |
| `assets/` | Icon and logo source art |

## Coming from v1

The original Electron app is tagged `v1-final`. **File → Import from Stenographer v1…** (or `steno import-v1`) brings its meetings, notes and recordings over; it reads a copy of the v1 database and is safe to repeat. Not carried over: spaces, todos, custom templates, dictation, rich-text notes.

## License

See [LICENSE](LICENSE).
