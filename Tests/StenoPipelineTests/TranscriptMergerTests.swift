import Foundation
import Testing

@testable import StenoPipeline
import StenoModel

private func w(_ text: String, _ start: Double, _ end: Double, _ track: TrackKind = .system) -> ASRWord {
    ASRWord(track: track, start: start, end: end, text: text, confidence: 1)
}

private func words(_ sentence: String, from start: Double, step: Double = 0.3, track: TrackKind) -> [ASRWord] {
    sentence.split(separator: " ").enumerated().map { i, t in
        w(String(t), start + Double(i) * step, start + Double(i) * step + 0.25, track)
    }
}

@Suite struct SpeakerAssignmentTests {
    let turns = [SpeakerTurn(speaker: "S1", start: 0, end: 2), SpeakerTurn(speaker: "S2", start: 5, end: 8)]

    @Test func midpointInsideTurn() {
        #expect(TranscriptMerger.assignSpeakers(words: [w("a", 5.5, 5.9)], turns: turns) == ["S2"])
    }

    @Test func nearestTurnWithinHalfSecond() {
        #expect(TranscriptMerger.assignSpeakers(words: [w("a", 4.4, 4.6)], turns: turns) == ["S2"])
    }

    @Test func carriesForwardPreviousSpeaker() {
        // Second word sits 1.5 s from S1 and 1.5 s from S2: neither is within 0.5 s.
        let result = TranscriptMerger.assignSpeakers(words: [w("a", 1, 1.2), w("b", 3.4, 3.6)], turns: turns)
        #expect(result == ["S1", "S1"])
    }

    @Test func firstWordFallsBackToNearestTurn() {
        #expect(TranscriptMerger.assignSpeakers(words: [w("a", 3.9, 4.1)], turns: turns) == ["S2"])
    }

    @Test func noTurnsMeansS1() {
        #expect(TranscriptMerger.assignSpeakers(words: [w("a", 1, 2), w("b", 3, 4)], turns: []) == ["S1", "S1"])
    }
}

@Suite struct UtteranceTests {
    private func attributed(_ ws: [ASRWord], _ speaker: String = "S1") -> [TranscriptWord] {
        ws.map { TranscriptWord(word: $0, speaker: speaker) }
    }

    @Test func gapOverThresholdSplits() {
        let us = TranscriptMerger.buildUtterances(attributed([w("one", 0, 0.5), w("two", 1.8, 2.2)]))
        #expect(us.map(\.text) == ["one", "two"])
        let joined = TranscriptMerger.buildUtterances(attributed([w("one", 0, 0.5), w("two", 1.6, 2.2)]))
        #expect(joined.map(\.text) == ["one two"])
    }

    @Test func longRunBreaksAtNextSentenceEnd() {
        // Words every 0.5 s for 40 s; only the word at 32 s ends a sentence.
        let ws = (0..<80).map { i -> ASRWord in
            let t = Double(i) * 0.5
            return w(i == 64 ? "end." : (i == 10 ? "early." : "word"), t, t + 0.4)
        }
        let us = TranscriptMerger.buildUtterances(attributed(ws))
        #expect(us.count == 2)
        #expect(us[0].text.hasSuffix("end."))
        #expect(us[0].end == 32.4)
    }

    @Test func hardBreakAt45Seconds() {
        let ws = (0..<120).map { i -> ASRWord in w("word", Double(i) * 0.5, Double(i) * 0.5 + 0.4) }
        let us = TranscriptMerger.buildUtterances(attributed(ws))
        #expect(us.count == 2)
        #expect(us[0].end - us[0].start <= 45)
    }

    @Test func speakerChangeSplits() {
        let a = TranscriptWord(word: w("hi", 0, 0.3), speaker: "S1")
        let b = TranscriptWord(word: w("there", 0.4, 0.7), speaker: "S2")
        #expect(TranscriptMerger.buildUtterances([a, b]).count == 2)
    }
}

@Suite struct EchoTests {
    @Test func identicalSystemSpeechDropsMicUtterance() {
        let sentence = "we should ship the new onboarding flow"
        let mic = words(sentence, from: 10.2, track: .mic)
        let system = words(sentence, from: 10, track: .system)
        let doc = TranscriptMerger.merge(
            runID: UUID(), mode: .call, asr: [.mic: mic, .system: system],
            turns: [SpeakerTurn(speaker: "S1", start: 9, end: 13)], diarizer: "test", diarizationError: nil)
        #expect(!doc.utterances.contains { $0.track == .mic })
        #expect(!doc.words.contains { $0.word.track == .mic })
        #expect(doc.utterances.map(\.speaker) == ["S1"])
    }

    @Test func unrelatedSystemSpeechKeepsMicUtterance() {
        let mic = words("I disagree with that", from: 20, track: .mic)
        let system = words("the payment migration is a risk", from: 20, track: .system)
        let doc = TranscriptMerger.merge(
            runID: UUID(), mode: .call, asr: [.mic: mic, .system: system],
            turns: [SpeakerTurn(speaker: "S1", start: 19, end: 23)], diarizer: "test", diarizationError: nil)
        let mine = doc.utterances.filter { $0.track == .mic }
        #expect(mine.map(\.text) == ["I disagree with that"])
        #expect(mine.first?.speaker == "Me")
        #expect(doc.speakers.map(\.id) == ["Me", "S1"])
        #expect(doc.speakers.first?.isMe == true)
        // Same start: mic sorts first.
        #expect(doc.utterances.first?.track == .mic)
    }

    @Test func shortUtteranceDroppedOnlyWhenAllTokensEchoed() {
        let system = words("yes okay sounds good", from: 5, track: .system)
        let echoed = Utterance(speaker: "Me", track: .mic, start: 5.3, end: 5.9, text: "Okay, good")
        let mine = Utterance(speaker: "Me", track: .mic, start: 5.3, end: 5.9, text: "okay sure")
        #expect(TranscriptMerger.isEcho(echoed, systemWords: system))
        #expect(!TranscriptMerger.isEcho(mine, systemWords: system))
    }
}
