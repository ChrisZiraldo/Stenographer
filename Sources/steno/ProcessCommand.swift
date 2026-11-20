import ArgumentParser
import Foundation
import StenoModel
import StenoPipeline

func timestamp(_ seconds: Double) -> String {
    let s = Int(seconds)
    return String(format: "%02d:%02d", s / 60, s % 60)
}

struct Process: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Transcribe and diarize a captured session.")

    @Argument var dir: String
    @Option var maxSpeakers: Int?
    @Flag var json = false
    @Option(help: .hidden) var runId: String?

    func run() async throws {
        let runID = try runId.map { guard let id = UUID(uuidString: $0) else { throw ValidationError("bad --run-id") }; return id } ?? UUID()
        let processor = SessionProcessor(transcriber: Transcriber(), diarizer: Diarizer())
        let timings = StageTimings()
        let doc = try await processor.process(sessionDir: absoluteURL(dir), runID: runID, maxSpeakers: maxSpeakers) {
            stage, fraction in timings.mark(stage, fraction)
        }
        if json {
            try printJSON(doc)
            return
        }
        for u in doc.utterances { print("[\(timestamp(u.start))] \(u.speaker): \(u.text)") }
        print("run \(runID.uuidString) · diarizer \(doc.diarizer)\(doc.diarizationError.map { " (\($0))" } ?? "")")
        print("speakers: \(doc.speakers.map(\.id).joined(separator: ", "))")
        print(timings.summary())
    }
}

final class StageTimings: @unchecked Sendable {
    private let lock = NSLock()
    private var started: [ProcessStage: ContinuousClock.Instant] = [:]
    private var elapsed: [ProcessStage: Duration] = [:]

    func mark(_ stage: ProcessStage, _ fraction: Double) {
        lock.withLock {
            if fraction == 0, started[stage] == nil { started[stage] = .now }
            if fraction == 1, let s = started[stage] { elapsed[stage] = .now - s }
        }
    }

    func summary() -> String {
        lock.withLock {
            ProcessStage.allCases.map { stage in
                let d = elapsed[stage].map { String(format: "%.2fs", $0 / .seconds(1)) } ?? "—"
                return "\(stage.rawValue) \(d)"
            }.joined(separator: " · ")
        }
    }
}
