import AppKit
import Foundation
import Observation
import StenoAudio
import StenoModel
import StenoNotes
import StenoStore

enum SettingsKey {
    static let captureMode = "capture.mode"
    static let micDeviceUID = "capture.micDeviceUID"
    static let liveEnabled = "live.enabled"
    static let maxSpeakers = "diarization.maxSpeakers"
    static let onboardingCompleted = "onboarding.completed"

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [
            captureMode: CaptureMode.call.rawValue, micDeviceUID: "", liveEnabled: true, maxSpeakers: 0,
            onboardingCompleted: false,
        ])
    }
}

enum ModelStatus: Equatable {
    case preparing, ready
    case failed(String)
}

struct ProcessingProgress: Equatable {
    var sessionID: String
    var fraction: Double
}

@Observable @MainActor
final class AppModel {
    let paths: AppPaths
    let database: StenoDatabase
    let jobs: JobRunner
    let worker: WorkerClient
    let recorder: RecorderController

    var sessions: [SessionRecord] = []
    var modelStatus = ModelStatus.preparing
    var processing: ProcessingProgress?
    var banner: String?
    var alert: String?
    var showOnboarding = false
    var selection: String?

    init() throws {
        SettingsKey.registerDefaults()
        LLMSettings.registerDefaults()
        paths = try AppPaths()
        database = try StenoDatabase(paths: paths)
        let worker = WorkerClient()
        self.worker = worker
        jobs = JobRunner(database: database) { dir, runID in
            try await worker.process(
                sessionDir: dir, runID: runID, maxSpeakers: UserDefaults.standard.integer(forKey: SettingsKey.maxSpeakers))
        }
        recorder = RecorderController(paths: paths, database: database, jobs: jobs, worker: worker)
        recorder.app = self
        showOnboarding = !UserDefaults.standard.bool(forKey: SettingsKey.onboardingCompleted)
    }

    func launch() async {
        worker.receiver.onProgress = { [weak self] stage, fraction in
            Task { @MainActor in await self?.updateProgress(stage: stage, fraction: fraction) }
        }
        worker.receiver.onLiveSegment = { [weak self] segment in
            Task { @MainActor in self?.recorder.received(segment) }
        }
        worker.onLiveRestarted = { [weak self] in
            Task { @MainActor in self?.banner = "Live captions restarted" }
        }
        observeSessions()
        do {
            try await RecoveryService(database: database, jobs: jobs).run()
        } catch {
            alert = "Recovery failed: \(error.localizedDescription)"
        }
        await jobs.start()
        await prepareModels()
    }

    func prepareModels() async {
        modelStatus = .preparing
        do {
            try await worker.prepareModels()
            modelStatus = .ready
        } catch {
            modelStatus = .failed(error.localizedDescription)
        }
    }

    private func observeSessions() {
        let stream = SessionRepository(database).observeAll()
        Task { [weak self] in
            do {
                for try await sessions in stream { self?.sessions = sessions }
            } catch {
                self?.alert = "Library unavailable: \(error.localizedDescription)"
            }
        }
    }

    private func updateProgress(stage: String, fraction: Double) async {
        guard let id = await jobs.runningSessionID else { return }
        let weights: [String: (Double, Double)] = [
            "finalize": (0, 0.05), "transcribe": (0.05, 0.55), "diarize": (0.6, 0.35), "merge": (0.95, 0.05),
        ]
        let (base, span) = weights[stage] ?? (0, 0)
        processing = ProcessingProgress(sessionID: id, fraction: base + span * fraction)
    }

    func session(id: String?) -> SessionRecord? {
        guard let id else { return nil }
        return sessions.first { $0.id == id }
    }

    func sessionDirectory(_ session: SessionRecord) -> URL { paths.sessionDirectory(folder: session.folder) }

    // MARK: - Library actions

    func reprocess(_ session: SessionRecord) async {
        do {
            if session.status == .ready || session.status == .failed {
                try SessionRepository(database).transition(id: session.id, to: .processing)
            }
            try await jobs.enqueueProcess(sessionID: session.id)
        } catch {
            alert = error.localizedDescription
        }
    }

    func delete(_ session: SessionRecord) {
        do {
            if selection == session.id { selection = nil }
            try SessionRepository(database).delete(id: session.id)
        } catch {
            alert = error.localizedDescription
        }
    }

    func setStarred(_ session: SessionRecord, _ starred: Bool) {
        do { try SessionRepository(database).setStarred(id: session.id, starred: starred) } catch {
            alert = error.localizedDescription
        }
    }

    func setTitle(_ session: SessionRecord, _ title: String) {
        do { try SessionRepository(database).setTitle(id: session.id, title: title) } catch {
            alert = error.localizedDescription
        }
    }

    func search(_ text: String) -> Set<String>? {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return Set((try? SearchIndex.search(database, text)) ?? [])
    }

    func importAudio() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio, .movie]
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        let urls = panel.urls
        let paths = paths
        Task {
            for url in urls {
                let id = UUID()
                do {
                    let manifest = try await Task.detached {
                        try Importer.importAudio(from: url, into: paths.sessionDirectory(id: id), id: id)
                    }.value
                    try SessionRepository(database).create(
                        manifest: manifest, title: url.deletingPathExtension().lastPathComponent)
                    try await jobs.enqueueProcess(sessionID: id.uuidString)
                    selection = id.uuidString
                } catch {
                    try? FileManager.default.removeItem(at: paths.sessionDirectory(id: id))
                    alert = "Import of \(url.lastPathComponent) failed: \(error.localizedDescription)"
                }
            }
        }
    }

    var importingV1 = false

    func importV1() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.directoryURL = V1Importer.defaultRoot
        panel.message = "Choose the Stenographer v1 data folder"
        panel.prompt = "Import"
        guard panel.runModal() == .OK, let root = panel.url else { return }
        let database = database
        importingV1 = true
        Task {
            defer { importingV1 = false }
            do {
                let report = try await Task.detached { try V1Importer(database: database, v1Root: root).run() }.value
                for id in report.toProcess { try await jobs.enqueueProcess(sessionID: id) }
                alert = "Stenographer v1 import — \(report.summary)"
            } catch {
                alert = "Stenographer v1 import failed: \(error.localizedDescription)"
            }
        }
    }

    func exportMarkdown() {
        guard let session = session(id: selection) else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.init(filenameExtension: "md")!]
        panel.nameFieldStringValue = MarkdownExporter.fileName(session: session)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try MarkdownExporter.export(session: session, database: database).write(to: url, atomically: true, encoding: .utf8)
        } catch {
            alert = "Export failed: \(error.localizedDescription)"
        }
    }

    nonisolated static func storageSize(root: URL) -> Int64 {
        let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey])
        var total: Int64 = 0
        while let url = enumerator?.nextObject() as? URL {
            total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }
}
