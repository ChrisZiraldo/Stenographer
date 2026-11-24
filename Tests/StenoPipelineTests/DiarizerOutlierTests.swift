import StenoModel
import Testing

@testable import StenoPipeline

@Suite struct DiarizerOutlierTests {
    // Unit vectors on the axes: distance 0 to itself, 1 to any other axis.
    private let kit: [Float] = [1, 0, 0]
    private let ana: [Float] = [0, 1, 0]
    private let stranger: [Float] = [0, 0, 1]
    private let nearKit: [Float] = [1, 0.2, 0]  // distance ≈ 0.02

    private func output(_ turns: [(String, Double, Double)]) -> DiarizationOutput {
        DiarizationOutput(
            turns: turns.map { SpeakerTurn(speaker: $0.0, start: $0.1, end: $0.2) },
            speakerDatabase: ["S1": kit, "S2": ana])
    }

    @Test func turnFarFromItsSpeakersVoiceMovesToANewSpeaker() {
        let out = output([("S1", 0, 5), ("S1", 5, 9), ("S2", 9, 14)])
        let result = Diarizer.movingOutliers(
            in: out, candidates: Diarizer.outlierCandidates(in: out), embeddings: [nearKit, stranger, ana])
        #expect(result.turns.map(\.speaker) == ["S1", "S3", "S2"])
        #expect(result.turns.map(\.start) == out.turns.map(\.start))
    }

    @Test func theNewSpeakerGetsNoStoredVoice() {
        let out = output([("S1", 0, 5)])
        let result = Diarizer.movingOutliers(in: out, candidates: [0], embeddings: [stranger])
        #expect(result.turns[0].speaker == "S3")
        #expect(result.speakerDatabase.keys.sorted() == ["S1", "S2"])
    }

    @Test func turnsMatchingTheirOwnVoiceAreKept() {
        let out = output([("S1", 0, 5), ("S2", 5, 10)])
        let result = Diarizer.movingOutliers(in: out, candidates: [0, 1], embeddings: [nearKit, ana])
        #expect(result.turns == out.turns)
    }

    @Test func turnIsJudgedAgainstItsOwnSpeakerNotAnyOther() {
        // The clip sounds like Ana, but the diarizer called it Kit: that is exactly the mistake to catch.
        let out = output([("S1", 0, 5)])
        let result = Diarizer.movingOutliers(in: out, candidates: [0], embeddings: [ana])
        #expect(result.turns[0].speaker == "S3")
    }

    @Test func onlyLongTurnsOfSpeakersWithAStoredVoiceAreJudged() {
        let out = output([("S1", 0, 1.9), ("S1", 2, 4), ("S9", 4, 10)])
        #expect(Diarizer.outlierCandidates(in: out) == [1])
    }

    @Test func countMismatchLeavesTurnsAlone() {
        let out = output([("S1", 0, 5), ("S1", 5, 10)])
        let result = Diarizer.movingOutliers(in: out, candidates: [0, 1], embeddings: [stranger])
        #expect(result.turns == out.turns)
    }
}
