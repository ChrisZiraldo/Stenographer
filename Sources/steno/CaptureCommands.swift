import ArgumentParser
import Foundation
import StenoAudio
import StenoModel
import StenoPipeline
import StenoStore

extension CaptureMode: ExpressibleByArgument {}

struct Devices: ParsableCommand {
    static let configuration = CommandConfiguration(abstract: "List audio input devices.")

    func run() throws {
        for d in DeviceCatalog.inputDevices() {
            print("\(d.uid)\t\(d.name)\t\(d.inputChannels) ch\t\(Int(d.nominalSampleRate)) Hz")
        }
        print("default input:  \(DeviceCatalog.defaultInput().map { "\($0.name) (\($0.uid))" } ?? "none")")
        print("default output: \(DeviceCatalog.defaultOutput().map { "\($0.name) (\($0.uid))" } ?? "none")")
    }
}

struct Record: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Record a session until Ctrl-C.")

    @Option var out: String
    @Option var mode: CaptureMode = .call
    @Option(help: "Input device UID (default: follow system default).") var mic: String?
    @Flag(help: "Print live captions.") var live = false

    func run() async throws {
        Responsibility.becomeResponsibleProcess()
        let dir = absoluteURL(out)
        let session = CaptureSession(
            config: CaptureConfig(mode: mode, micDeviceUID: mic, sessionDirectory: dir, sessionID: UUID(), liveAudio: live))
        let (stopRequests, stopContinuation) = AsyncStream.makeStream(of: Void.self)

        signal(SIGINT, SIG_IGN)
        let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        sigint.setEventHandler { stopContinuation.yield() }
        sigint.resume()

        try session.start()
        print("Recording \(mode.rawValue) → \(dir.path) (pid \(getpid())). Ctrl-C to stop.")

        let eventsTask = Task {
            for await event in session.events {
                print("event: \(event)")
                switch event {
                case .stoppedForDiskFull, .error: stopContinuation.yield()
                default: break
                }
            }
        }
        let levelsTask = Task {
            var n = 0
            for await l in session.levels {
                n += 1
                if n % 10 == 0 {
                    func f(_ v: Float?) -> String { v.map { String(format: "%6.1f dBFS", $0) } ?? "     —    " }
                    print("levels mic \(f(l.micDBFS))  system \(f(l.systemDBFS))")
                }
            }
        }
        let liveTask = live ? startLiveCaptions(session: session, mode: mode) : nil

        for await _ in stopRequests { break }
        let manifest = try await session.stop()
        await liveTask?.value
        eventsTask.cancel()
        levelsTask.cancel()
        print("Stopped: \(manifest.parts.count) parts, \(String(format: "%.1f", manifest.durationSeconds)) s")
    }
}

/// Feeds capture audio to a `LiveTranscriber` and prints captions; completes after capture stops.
func startLiveCaptions(session: CaptureSession, mode: CaptureMode) -> Task<Void, Never> {
    let live = LiveTranscriber(transcriber: Transcriber(), mode: mode)
    let printer = Task {
        for await s in live.segments {
            print("[\(timestamp(s.start))] \(s.speakerLabel): \(s.text) (lat \(String(format: "%.1f", s.latency))s)")
        }
    }
    return Task {
        do { try await live.prepare() } catch { print("live captions unavailable: \(error.localizedDescription)") }
        for await chunk in session.liveAudio { await live.append(chunk) }
        await live.finish()
        await printer.value
    }
}

struct Recover: ParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Repair a session left in recording state.")
    @Argument var dir: String

    func run() throws {
        let m = try Recovery.repairSession(at: absoluteURL(dir))
        print("state \(m.state.rawValue), \(m.parts.count) parts, \(String(format: "%.1f", m.durationSeconds)) s")
    }
}

struct Finalize: ParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Write continuous track files and the playback mix.")
    @Argument var dir: String

    func run() throws {
        let m = try Finalizer.finalize(at: absoluteURL(dir))
        print("tracks \(m.presentTracks.map(\.rawValue)), \(m.timelineSamples) samples, playback \(m.playbackFile ?? "none")")
    }
}

struct Import: ParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Import an audio file as a session.")
    @Argument var file: String
    @Option var out: String

    func run() throws {
        let m = try Importer.importAudio(from: absoluteURL(file), into: absoluteURL(out), id: UUID())
        print("imported \(String(format: "%.1f", m.durationSeconds)) s → \(out)")
    }
}

struct ImportV1: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "import-v1", abstract: "Import Stenographer v1 meetings into the v2 library.")
    @Option(help: "v1 data folder (default ~/Library/Application Support/Stenographer).") var v1Root: String?
    @Option(help: "v2 data root (default ~/Library/Application Support/Stenographer2).") var dataRoot: String?

    func run() throws {
        let paths = try dataRoot.map { try AppPaths(root: absoluteURL($0)) } ?? AppPaths()
        let database = try StenoDatabase(paths: paths)
        let importer = V1Importer(database: database, v1Root: v1Root.map(absoluteURL) ?? V1Importer.defaultRoot)
        print(try importer.run().summary)
    }
}
