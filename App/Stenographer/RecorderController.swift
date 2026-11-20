import AVFoundation
import Foundation
import Observation
import StenoAudio
import StenoModel
import StenoStore

@Observable @MainActor
final class RecorderController {
    struct Active {
        var sessionID: String
        var mode: CaptureMode
        var startedAt: Date
    }

    private let paths: AppPaths
    private let database: StenoDatabase
    private let jobs: JobRunner
    private let worker: WorkerClient
    weak var app: AppModel?

    private(set) var active: Active?
    private(set) var levels = Levels(micDBFS: nil, systemDBFS: nil)
    private(set) var liveSegments: [LiveSegment] = []
    var systemAudioSilent = false
    private var session: CaptureSession?
    private var tasks: [Task<Void, Never>] = []
    private var stopping = false

    var isRecording: Bool { active != nil }

    init(paths: AppPaths, database: StenoDatabase, jobs: JobRunner, worker: WorkerClient) {
        self.paths = paths
        self.database = database
        self.jobs = jobs
        self.worker = worker
    }

    func start() async {
        guard active == nil, !stopping else { return }
        let defaults = UserDefaults.standard
        let mode = CaptureMode(rawValue: defaults.string(forKey: SettingsKey.captureMode) ?? "") ?? .call
        let needsMic = mode != .systemOnly
        if !defaults.bool(forKey: SettingsKey.onboardingCompleted)
            || (needsMic && AVCaptureDevice.authorizationStatus(for: .audio) != .authorized)
        {
            app?.showOnboarding = true
            return
        }

        let id = UUID()
        let live = defaults.bool(forKey: SettingsKey.liveEnabled)
        let config = CaptureConfig(
            mode: mode, micDeviceUID: defaults.string(forKey: SettingsKey.micDeviceUID), sessionDirectory: paths.sessionDirectory(id: id),
            sessionID: id, liveAudio: live)
        let capture = CaptureSession(config: config)
        do {
            try await Task.detached { try capture.start() }.value
            let manifest = try ManifestIO.read(from: ManifestIO.url(in: config.sessionDirectory))
            try SessionRepository(database).create(manifest: manifest)
        } catch {
            _ = try? await capture.stop()
            app?.alert = "Recording could not start: \(error.localizedDescription)"
            return
        }
        await jobs.pause()
        session = capture
        active = Active(sessionID: id.uuidString, mode: mode, startedAt: Date())
        liveSegments = []
        systemAudioSilent = false
        app?.selection = id.uuidString

        tasks.append(Task { [weak self] in
            for await l in capture.levels { self?.levels = l }
        })
        tasks.append(Task { [weak self] in
            for await event in capture.events { await self?.handle(event) }
        })
        if live {
            let worker = worker
            let voices = ((try? SpeakerLibrary(database).all()) ?? []).map {
                KnownVoice(name: $0.name, vector: VoiceVector.vector($0.centroid))
            }
            tasks.append(Task.detached {
                do { try await worker.startLive(mode: mode, voices: voices) } catch {
                    StenoLog.app.error("Live captions unavailable: \(error.localizedDescription, privacy: .public)")
                }
                for await chunk in capture.liveAudio { worker.appendLive(chunk) }
            })
        }
    }

    func stop() async {
        guard let active, let session, !stopping else { return }
        stopping = true
        defer { stopping = false }
        do {
            let manifest = try await session.stop()
            try SessionRepository(database).markCaptured(id: active.sessionID, manifest: manifest)
        } catch {
            app?.alert = "Stopping failed: \(error.localizedDescription). The recording will be recovered on next launch."
        }
        tasks.forEach { $0.cancel() }
        tasks = []
        if UserDefaults.standard.bool(forKey: SettingsKey.liveEnabled) { await worker.stopLive() }
        self.session = nil
        self.active = nil
        levels = Levels(micDBFS: nil, systemDBFS: nil)
        do { try await jobs.enqueueProcess(sessionID: active.sessionID) } catch {
            app?.alert = error.localizedDescription
        }
        await jobs.resume()
    }

    func received(_ segment: LiveSegment) {
        guard active != nil else { return }
        liveSegments.append(segment)
    }

    private func handle(_ event: CaptureEvent) async {
        switch event {
        case .systemAudioSilent:
            systemAudioSilent = true
        case .stoppedForDiskFull:
            app?.alert = "Recording stopped: the disk is almost full."
            await stop()
        case .error(let message):
            app?.alert = "Recording stopped: \(message)"
            await stop()
        case .overrun(let track, let frames):
            StenoLog.app.error("Overrun on \(track.rawValue, privacy: .public): \(frames)")
        case .partStarted, .partEnded, .diskLow:
            break
        }
    }
}
