import Foundation
import Testing

@testable import StenoNotes
import StenoModel
import StenoStore

@Suite struct ChunkerTests {
    @Test func neverSplitsLinesAndCoversEachOnce() {
        let limit = 1_000
        var rng = SystemRandomNumberGenerator()
        var lines: [String] = []
        var total = 0
        var i = 0
        while total < 5 * limit {
            let line = "[\(i)] " + String(repeating: "w", count: Int.random(in: 10...180, using: &rng))
            lines.append(line)
            total += line.count + 1
            i += 1
        }
        let chunks = PromptChunker.chunks(lines, limit: limit)
        #expect(chunks.count >= 5)
        #expect(chunks.allSatisfy { $0.count <= limit })
        #expect(chunks.flatMap { $0.split(separator: "\n").map(String.init) } == lines)
    }

    @Test func oversizedLineIsItsOwnChunk() {
        let long = String(repeating: "x", count: 50)
        #expect(PromptChunker.chunks(["a", long, "b"], limit: 10) == ["a", long, "b"])
    }
}

@Suite struct FormatterTests {
    @Test func formatsTimestampAndSpeakerName() {
        let speaker = SpeakerRecord(id: "r:S1", runId: "r", label: "S1", displayName: "Alex", isMe: false, colorIndex: 0)
        let line = TranscriptLine(id: 1, start: 65.4, end: 66, text: "hello", track: .system, speaker: speaker)
        #expect(TranscriptFormatter.lines([line]) == ["[01:05] Alex: hello"])
    }

    @Test func cleansTitles() {
        #expect(NoteGenerator.cleanTitle("  \"Roadmap Review\"\n") == "Roadmap Review")
        #expect(NoteGenerator.cleanTitle(String(repeating: "a", count: 200)).count == 120)
    }
}

@Suite struct SSEParserTests {
    @Test func yieldsDeltasUntilDone() {
        let stream = """
            : keep-alive
            data: {"choices":[{"delta":{"role":"assistant"}}]}

            data: {"choices":[{"delta":{"content":"Hel"}}]}
            data: {"choices":[{"delta":{"content":"lo"}}]}
            data: [DONE]
            data: {"choices":[{"delta":{"content":"ignored"}}]}
            """
        var parser = SSEParser()
        var deltas: [String] = []
        lines: for line in stream.split(separator: "\n", omittingEmptySubsequences: false) {
            switch parser.consume(String(line)) {
            case .delta(let text): deltas.append(text)
            case .done: break lines
            case .none: continue
            }
        }
        #expect(deltas == ["Hel", "lo"])
    }
}
