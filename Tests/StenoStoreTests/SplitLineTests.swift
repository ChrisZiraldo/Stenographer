import Foundation
import Testing

import StenoModel
@testable import StenoStore

@Suite struct SplitLineTests {
    private let text = "When are you back uh next Tuesday okay so"  // 9 words

    /// One run with S1 (the whole line, 0–9 s) and S2 (a later line).
    private func setup() throws -> (f: Fixture, run: String, line: Int64) {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .captured)
        try f.sessions.create(manifest: m)
        let doc = TranscriptDocument(
            runId: UUID(), asrModel: "test", diarizer: "test", diarizationError: nil,
            speakers: [TranscriptSpeaker(id: "S1", isMe: false), TranscriptSpeaker(id: "S2", isMe: false)], words: [],
            utterances: [
                Utterance(speaker: "S1", track: .system, start: 0, end: 9, text: text),
                Utterance(speaker: "S2", track: .system, start: 20, end: 22, text: "sounds good"),
            ])
        try f.runs.save(document: doc, sessionID: m.id.uuidString)
        let run = doc.runId.uuidString
        return (f, run, try f.runs.utterances(runID: run)[0].id)
    }

    private func summary(_ f: Fixture, _ run: String) throws -> [String] {
        try f.runs.utterances(runID: run).map { "\($0.speaker.label): \($0.text)" }
    }

    @Test func middleWordsGoToAnotherSpeakerAndBothSidesStay() throws {
        let (f, run, line) = try setup()
        let times = (0..<9).map { Double($0)...(Double($0) + 0.9) }
        try f.runs.assignWords(utteranceID: line, range: 4..<7, to: "\(run):S2", wordTimes: times)
        #expect(try summary(f, run) == [
            "S1: When are you back", "S2: uh next Tuesday", "S1: okay so", "S2: sounds good",
        ])
        let lines = try f.runs.utterances(runID: run)
        #expect(lines.map(\.start) == [0, 4, 7, 20])
        #expect(lines.map(\.end) == [3.9, 6.9, 9, 22])  // first starts and last ends where the original did
    }

    @Test func tailWordsSplitTheLineInTwo() throws {
        let (f, run, line) = try setup()
        try f.runs.assignWords(utteranceID: line, range: 7..<9, to: "\(run):S2")
        #expect(try summary(f, run) == ["S1: When are you back uh next Tuesday", "S2: okay so", "S2: sounds good"])
        let lines = try f.runs.utterances(runID: run)
        #expect(lines[0].start == 0 && lines[1].end == 9)
        #expect(lines[1].start > 5 && lines[1].start < 9)  // estimated by word length, inside the line
    }

    @Test func wholeLineMovesWithoutSplittingAndAnEmptiedSpeakerIsRemoved() throws {
        let (f, run, line) = try setup()
        try f.runs.assignWords(utteranceID: line, range: 0..<9, to: "\(run):S2")
        #expect(try summary(f, run) == ["S2: \(text)", "S2: sounds good"])
        #expect(try f.runs.speakers(runID: run).map(\.label) == ["S2"])
    }

    @Test func rejectsEmptyOrOutOfRangeSelections() throws {
        let (f, run, line) = try setup()
        #expect(throws: StoreError.self) { try f.runs.assignWords(utteranceID: line, range: 3..<3, to: "\(run):S2") }
        #expect(throws: StoreError.self) { try f.runs.assignWords(utteranceID: line, range: 5..<10, to: "\(run):S2") }
        #expect(try summary(f, run).first == "S1: \(text)")
    }

    @Test func createdSpeakerGetsAUniqueLabelAndNextColor() throws {
        let (f, run, line) = try setup()
        let ben = try f.runs.createSpeaker(runID: run, displayName: "  Ben Franks ")
        let other = try f.runs.createSpeaker(runID: run, displayName: "Yves")
        #expect([ben.label, other.label] == ["X1", "X2"])
        #expect(ben.name == "Ben Franks" && ben.colorIndex == 2 && other.colorIndex == 3)
        #expect(throws: StoreError.self) { try f.runs.createSpeaker(runID: run, displayName: "  ") }
        try f.runs.assignWords(utteranceID: line, range: 4..<7, to: ben.id)
        #expect(try summary(f, run).contains("X1: uh next Tuesday"))
    }
}
