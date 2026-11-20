import Foundation
import Testing

import StenoAudio
@testable import StenoPipeline
import StenoModel

let modelTestsEnabled = ProcessInfo.processInfo.environment["STENO_MODEL_TESTS"] == "1"

let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/generated")

func normalizedTokens(_ text: String) -> [String] { TranscriptMerger.tokens(text) }

/// Word-level Levenshtein distance / reference length.
func wordErrorRate(reference: [String], hypothesis: [String]) -> Double {
    guard !reference.isEmpty else { return hypothesis.isEmpty ? 0 : 1 }
    var previous = Array(0...hypothesis.count)
    for (i, r) in reference.enumerated() {
        var current = [i + 1] + [Int](repeating: 0, count: hypothesis.count)
        for (j, h) in hypothesis.enumerated() {
            current[j + 1] = min(previous[j + 1] + 1, current[j] + 1, previous[j] + (r == h ? 0 : 1))
        }
        previous = current
    }
    return Double(previous[hypothesis.count]) / Double(reference.count)
}

@Suite struct WERHelperTests {
    @Test func countsSubstitutionsInsertionsDeletions() {
        #expect(wordErrorRate(reference: ["a", "b", "c", "d"], hypothesis: ["a", "x", "c"]) == 0.5)
        #expect(wordErrorRate(reference: ["a", "b"], hypothesis: ["a", "b"]) == 0)
    }
}

@Suite(.enabled(if: modelTestsEnabled), .serialized) struct ModelQualityTests {
    struct Span: Decodable { var speaker: String; var start: Double; var end: Double }

    @Test func twoSpeakerFixture() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("steno-model-\(UUID().uuidString)")
        try Importer.importAudio(from: fixtures.appendingPathComponent("two-speakers.wav"), into: dir, id: UUID())
        let processor = SessionProcessor(transcriber: Transcriber(), diarizer: Diarizer())
        let doc = try await processor.process(sessionDir: dir, runID: UUID(), maxSpeakers: nil)

        #expect(doc.diarizer == PipelineConstants.diarizerName)
        #expect(doc.speakers.count == 2)

        let spans = try JSONDecoder().decode(
            [Span].self, from: Data(contentsOf: fixtures.appendingPathComponent("two-speakers.rttm-like.json")))
        func reference(of word: TranscriptWord) -> String? {
            let mid = (word.word.start + word.word.end) / 2
            return spans.first { $0.start - 0.3 <= mid && mid <= $0.end + 0.3 }?.speaker
        }
        // Best of the two possible label mappings.
        let labels = doc.speakers.map(\.id)
        var best = 0
        for mapping in [[labels[0]: "A", labels[1]: "B"], [labels[0]: "B", labels[1]: "A"]] {
            best = max(best, doc.words.filter { reference(of: $0) == mapping[$0.speaker] }.count)
        }
        let accuracy = Double(best) / Double(doc.words.count)
        #expect(accuracy >= 0.9, "speaker accuracy \(accuracy)")

        let referenceText = try String(contentsOf: fixtures.appendingPathComponent("two-speakers.txt"), encoding: .utf8)
        let wer = wordErrorRate(
            reference: normalizedTokens(referenceText),
            hypothesis: normalizedTokens(doc.words.map(\.word.text).joined(separator: " ")))
        #expect(wer <= 0.10, "WER \(wer)")
    }
}
