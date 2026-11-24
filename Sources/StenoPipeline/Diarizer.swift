import FluidAudio
import Foundation
import StenoModel

public struct DiarizationOutput: Codable, Sendable {
    public var turns: [SpeakerTurn]
    public var speakerDatabase: [String: [Float]]

    public init(turns: [SpeakerTurn], speakerDatabase: [String: [Float]]) {
        self.turns = turns
        self.speakerDatabase = speakerDatabase
    }
}

/// pyannote community-1 (FluidAudio `OfflineDiarizerManager`) wrapper.
public actor Diarizer {
    private var managers: [Int: OfflineDiarizerManager] = [:]
    /// Separate from `managers`: live embedding must not overlap a running offline `process` on the same manager.
    private var liveEmbedder: OfflineDiarizerManager?

    public init() {}

    public func prepare() async throws {
        _ = try await manager(maxSpeakers: nil)
    }

    public func diarize(
        file: URL, maxSpeakers: Int?, progress: @escaping @Sendable (Int, Int) -> Void = { _, _ in }
    ) async throws -> DiarizationOutput {
        // OfflineDiarizerManager is not Sendable; this actor serializes all use of it.
        nonisolated(unsafe) let manager = try await manager(maxSpeakers: maxSpeakers)
        let result = try await manager.process(file, progressCallback: progress)
        let output = Self.remap(result)
        return try await separatingOutliers(output, file: file)
    }

    /// A turn this far from its speaker's voice (cosine distance) is a different person the clustering absorbed.
    /// Measured on a 32-minute call: 90% of the dominant speaker's turns are under 0.48; a different person's
    /// reply was 0.62 and 1.03. Across 13 sessions it flags 1.8% of turns of 2 s or more.
    static let outlierDistance: Float = 0.6
    /// Shorter clips give embeddings too noisy to judge.
    static let outlierMinTurnSeconds = 2.0

    /// Moves turns that don't match their speaker's voice to one extra speaker, so they are no longer attributed
    /// to the speaker whose cluster absorbed them. The extra speaker has no stored voice: its turns come from
    /// several people, so it must not be matched against, or saved to, the voice library.
    func separatingOutliers(_ output: DiarizationOutput, file: URL) async throws -> DiarizationOutput {
        let candidates = Self.outlierCandidates(in: output)
        guard !candidates.isEmpty else { return output }
        nonisolated(unsafe) let manager = try await embedder()
        let source = try AudioSourceFactory().makeDiskBackedSource(from: file, targetSampleRate: 16_000).source
        let embeddings = try await manager.embedSpans(
            audioSource: source, spans: candidates.map { output.turns[$0].start..<output.turns[$0].end })
        let result = Self.movingOutliers(in: output, candidates: candidates, embeddings: embeddings)
        let moved = zip(output.turns, result.turns).filter { $0.speaker != $1.speaker }.count
        if moved > 0 {
            StenoLog.pipeline.info("Diarization: \(moved, privacy: .public) turns don't match their speaker's voice")
        }
        return result
    }

    /// Indices of turns long enough to judge whose speaker has a stored voice.
    static func outlierCandidates(in output: DiarizationOutput) -> [Int] {
        output.turns.indices.filter {
            output.turns[$0].end - output.turns[$0].start >= outlierMinTurnSeconds
                && output.speakerDatabase[output.turns[$0].speaker] != nil
        }
    }

    /// `embeddings[i]` is the voice of `output.turns[candidates[i]]`. Returns `output` unchanged when nothing is
    /// an outlier or the counts disagree.
    static func movingOutliers(
        in output: DiarizationOutput, candidates: [Int], embeddings: [[Float]]
    ) -> DiarizationOutput {
        guard embeddings.count == candidates.count else { return output }
        let centroids = output.speakerDatabase.mapValues(VoiceVector.normalized)
        let label = "S\(output.speakerDatabase.count + 1)"
        var turns = output.turns
        for (index, embedding) in zip(candidates, embeddings) {
            guard let centroid = centroids[turns[index].speaker],
                VoiceVector.cosineDistance(VoiceVector.normalized(embedding), centroid) > outlierDistance
            else { continue }
            turns[index].speaker = label
        }
        return DiarizationOutput(turns: turns, speakerDatabase: output.speakerDatabase)
    }

    public func prepareLiveEmbedder() async throws {
        _ = try await embedder()
    }

    /// One speaker embedding (same space as the voice library) for a clip of 16 kHz mono audio.
    public func embed(samples: [Float]) async throws -> [Float] {
        nonisolated(unsafe) let manager = try await embedder()
        let seconds = Double(samples.count) / 16_000
        let result = try await manager.embedSpans(
            audioSource: ArrayAudioSampleSource(samples: samples), spans: [0..<seconds])
        guard let embedding = result.first else { throw OfflineDiarizationError.processingFailed("No embedding produced") }
        return embedding
    }

    private func embedder() async throws -> OfflineDiarizerManager {
        if let liveEmbedder { return liveEmbedder }
        let manager = OfflineDiarizerManager(config: .default)
        try await manager.prepareModels()
        liveEmbedder = manager
        return manager
    }

    private func manager(maxSpeakers: Int?) async throws -> OfflineDiarizerManager {
        let key = maxSpeakers ?? 0
        if let existing = managers[key] { return existing }
        var config = OfflineDiarizerConfig.default
        config.postProcessing.exclusiveSegments = true
        config.clustering.maxSpeakers = maxSpeakers
        let manager = OfflineDiarizerManager(config: config)
        try await manager.prepareModels()
        managers[key] = manager
        return manager
    }

    /// Renames raw speaker ids to S1, S2, … in order of first appearance.
    static func remap(_ result: DiarizationResult) -> DiarizationOutput {
        var names: [String: String] = [:]
        var turns: [SpeakerTurn] = []
        for segment in result.segments.sorted(by: { $0.startTimeSeconds < $1.startTimeSeconds }) {
            let name: String
            if let known = names[segment.speakerId] {
                name = known
            } else {
                name = "S\(names.count + 1)"
                names[segment.speakerId] = name
            }
            turns.append(
                SpeakerTurn(
                    speaker: name, start: Double(segment.startTimeSeconds), end: Double(segment.endTimeSeconds)))
        }
        var database: [String: [Float]] = [:]
        for (raw, embedding) in result.speakerDatabase ?? [:] {
            if let name = names[raw] { database[name] = embedding }
        }
        return DiarizationOutput(turns: turns, speakerDatabase: database)
    }
}
