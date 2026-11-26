import Foundation
import Testing

import StenoModel
@testable import StenoNotes

private func seg(_ track: TrackKind, _ label: String, _ start: Double, _ text: String) -> LiveSegment {
    LiveSegment(track: track, speakerLabel: label, start: start, end: start + 2, text: text, latency: 0)
}

private struct FakeProvider: LLMProvider {
    let id = "fake"
    let model = "fake"
    var maxPromptChars = 48_000
    var reply = "Topic now: budget"
    func stream(system: String, prompt: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { $0.yield(reply); $0.finish() }
    }
}

@Suite struct LiveSummarizerTests {
    @Test func keepsOnlyRecentWindow() {
        let segments = [seg(.system, "Others", 0, "ancient"), seg(.system, "Others", 1000, "recent")]
        let lines = LiveSummaryPrompt.lines(segments: segments, window: 300, maxChars: 10_000)
        #expect(lines == ["[16:40] Others: recent"])
    }

    @Test func trimsOldestToFit() {
        let segments = (0..<20).map { seg(.system, "Others", Double($0 * 5), "line number \($0)") }
        let lines = LiveSummaryPrompt.lines(segments: segments, maxChars: 100)
        #expect(lines.joined(separator: "\n").count <= 100)
        #expect(lines.last?.hasSuffix("line number 19") == true)
    }

    @Test func dropsMicEchoOfSystemSpeech() {
        let segments = [
            seg(.system, "Others", 10, "can we move the launch to friday"),
            seg(.mic, "Me", 10.5, "can we move the launch to friday"),
            seg(.mic, "Me", 14, "sure that works for me"),
        ]
        let lines = LiveSummaryPrompt.lines(segments: segments, maxChars: 10_000)
        #expect(lines.count == 2)
        #expect(!lines.contains { $0.contains("Me: can we move") })
    }

    @Test func summarizeReturnsNilWhenEmptyAndReplyOtherwise() async throws {
        #expect(try await LiveSummarizer.summarize(segments: [], provider: FakeProvider()) == nil)
        let out = try await LiveSummarizer.summarize(segments: [seg(.system, "Others", 0, "hello")], provider: FakeProvider())
        #expect(out == "Topic now: budget")
    }
}

@Suite struct LiveSummaryParseTests {
    @Test func parsesSections() {
        let s = LiveSummary.parse("Topic now: Picking the button component\nJust said:\n- A: one\n- B: two\nOpen question: Is it ready?")
        #expect(s == LiveSummary(topic: "Picking the button component", bullets: ["A: one", "B: two"], openQuestion: "Is it ready?"))
    }

    @Test func nothingMeansNoOpenQuestion() {
        #expect(LiveSummary.parse("Topic now: x\nOpen question: Nothing.").openQuestion == nil)
        #expect(LiveSummary.parse("Topic now: x\nJust said:\n- y").openQuestion == nil)
    }

    @Test func variantsOfNoQuestionAreDropped() {
        for none in ["None", "none.", "N/A", "No", "No open questions", "No open question in the captions", "-", ""] {
            #expect(LiveSummary.parse("Topic now: x\nOpen question: \(none)").openQuestion == nil, "\(none)")
        }
        #expect(LiveSummary.parse("Topic now: x\nOpen question: Notes: who owns it?").openQuestion != nil)
    }

    @Test func unstructuredReplyIsShownWhole() {
        #expect(LiveSummary.parse("They are talking about budgets.").topic == "They are talking about budgets.")
    }
}
