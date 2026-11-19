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
        return Self.remap(result)
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
