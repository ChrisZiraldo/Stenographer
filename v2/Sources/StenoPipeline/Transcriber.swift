import FluidAudio
import Foundation
import StenoModel

public enum PipelineConstants {
    public static let asrVersion: AsrModelVersion = .v3
    public static let asrModelName = "parakeet-tdt-0.6b-v3"
    public static let diarizerName = "pyannote-community-1"
    public static let noDiarizer = "none"
}

/// Parakeet TDT wrapper. One instance per process; models load lazily on first use.
public actor Transcriber {
    private let asr = AsrManager(config: .default)
    private var loaded = false

    public init() {}

    public func prepare() async throws {
        guard !loaded else { return }
        let models = try await AsrModels.downloadAndLoad(version: PipelineConstants.asrVersion)
        try await asr.loadModels(models)
        loaded = true
    }

    public func transcribe(file: URL, track: TrackKind) async throws -> [ASRWord] {
        try await prepare()
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(file, decoderState: &state)
        return Self.words(from: result.tokenTimings ?? [], track: track)
    }

    /// Transcribes 16 kHz mono samples with a fresh decoder state.
    public func transcribe(samples: [Float]) async throws -> ASRResult {
        try await prepare()
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        return try await asr.transcribe(samples, decoderState: &state)
    }

    /// Groups SentencePiece tokens into words with the same boundary rule as FluidAudio's
    /// `buildWordTimings`, additionally averaging token confidences per word.
    static func words(from tokens: [TokenTiming], track: TrackKind, offset: Double = 0) -> [ASRWord] {
        var words: [ASRWord] = []
        var text = ""
        var start = 0.0
        var end = 0.0
        var confidenceSum: Float = 0
        var tokenCount = 0

        func flush() {
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return }
            words.append(
                ASRWord(
                    track: track, start: start + offset, end: end + offset, text: trimmed,
                    confidence: confidenceSum / Float(max(tokenCount, 1))))
        }

        for token in tokens {
            let piece = token.token
            if piece.isEmpty || piece == "<blank>" || piece == "<pad>" { continue }
            let boundary = piece.hasPrefix("▁") || piece.hasPrefix(" ")
            if boundary || text.isEmpty {
                flush()
                text = String(piece.drop(while: { $0 == "▁" || $0 == " " }))
                start = token.startTime
                confidenceSum = 0
                tokenCount = 0
            } else {
                text += piece
            }
            end = token.endTime
            confidenceSum += token.confidence
            tokenCount += 1
        }
        flush()
        return words
    }
}
