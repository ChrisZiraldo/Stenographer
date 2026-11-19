import Foundation
import StenoAudio
import StenoModel

public enum ProcessStage: String, Sendable, CaseIterable {
    case finalize, transcribe, diarize, merge
}

public enum ProcessError: Error, LocalizedError {
    case stillRecording

    public var errorDescription: String? {
        switch self {
        case .stillRecording: "Session is still recording"
        }
    }
}

/// Turns a captured session into `runs/<run>/transcript.json`. Each stage checkpoints to disk and
/// is skipped on rerun when its output already decodes.
public final class SessionProcessor: Sendable {
    public let transcriber: Transcriber
    public let diarizer: Diarizer
    static let minimumTranscribableSamples: Int64 = 16_000
    static let minimumDiarizationWords = 3

    public init(transcriber: Transcriber, diarizer: Diarizer) {
        self.transcriber = transcriber
        self.diarizer = diarizer
    }

    public static func runDirectory(sessionDir: URL, runID: UUID) -> URL {
        sessionDir.appendingPathComponent("runs").appendingPathComponent(runID.uuidString)
    }

    public func process(
        sessionDir: URL, runID: UUID, maxSpeakers: Int?,
        progress: @escaping @Sendable (ProcessStage, Double) -> Void = { _, _ in }
    ) async throws -> TranscriptDocument {
        var manifest = try ManifestIO.read(from: ManifestIO.url(in: sessionDir))
        guard manifest.state == .captured else { throw ProcessError.stillRecording }

        progress(.finalize, 0)
        if !Finalizer.isFinalized(manifest, at: sessionDir) {
            manifest = try Finalizer.finalize(at: sessionDir)
        }
        progress(.finalize, 1)

        let runDir = Self.runDirectory(sessionDir: sessionDir, runID: runID)
        try FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)

        var asr: [TrackKind: [ASRWord]] = [:]
        let tracks = manifest.presentTracks
        for (i, kind) in tracks.enumerated() {
            progress(.transcribe, Double(i) / Double(tracks.count))
            let url = runDir.appendingPathComponent("asr-\(kind.rawValue).json")
            if let cached = try? StenoJSON.read([ASRWord].self, from: url) {
                asr[kind] = cached
                continue
            }
            let words: [ASRWord]
            if manifest.timelineSamples < Self.minimumTranscribableSamples {
                words = []
            } else {
                words = try await transcriber.transcribe(file: Finalizer.trackURL(kind, in: sessionDir), track: kind)
            }
            try StenoJSON.write(words, to: url)
            asr[kind] = words
        }
        progress(.transcribe, 1)

        progress(.diarize, 0)
        let target = manifest.mode.diarizationTrack
        var turns: [SpeakerTurn] = []
        var diarizerName = PipelineConstants.noDiarizer
        var diarizationError: String?
        if (asr[target]?.count ?? 0) >= Self.minimumDiarizationWords {
            let url = runDir.appendingPathComponent("diarization.json")
            if let cached = try? StenoJSON.read(DiarizationOutput.self, from: url) {
                turns = cached.turns
                diarizerName = PipelineConstants.diarizerName
            } else {
                do {
                    let output = try await diarizer.diarize(
                        file: Finalizer.trackURL(target, in: sessionDir), maxSpeakers: maxSpeakers
                    ) { done, total in progress(.diarize, total > 0 ? Double(done) / Double(total) : 0) }
                    try StenoJSON.write(output, to: url)
                    turns = output.turns
                    diarizerName = PipelineConstants.diarizerName
                } catch {
                    StenoLog.pipeline.error("Diarization failed: \(error.localizedDescription, privacy: .public)")
                    diarizationError = error.localizedDescription
                }
            }
        }
        progress(.diarize, 1)

        progress(.merge, 0)
        let document = TranscriptMerger.merge(
            runID: runID, mode: manifest.mode, asr: asr, turns: turns, diarizer: diarizerName,
            diarizationError: diarizationError)
        try StenoJSON.write(document, to: runDir.appendingPathComponent("transcript.json"))
        progress(.merge, 1)
        return document
    }
}
