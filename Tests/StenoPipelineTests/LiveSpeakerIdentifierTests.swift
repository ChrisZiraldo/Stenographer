import Foundation
import Testing

@testable import StenoPipeline
import StenoModel

/// Deterministic unit vectors: seeds far apart, `noise` perturbs a voice slightly.
private func voice(_ seed: Int, noise: Float = 0) -> [Float] {
    (0..<32).map { i in sin(Float(i * (seed + 1)) * 0.7 + Float(seed)) + noise * cos(Float(i) * 1.3) }
}

@Suite struct LiveSpeakerIdentifierTests {
    @Test func namesASavedVoiceAndNumbersStrangers() {
        var id = LiveSpeakerIdentifier(known: [KnownVoice(name: "Priya", vector: voice(1))])
        #expect(id.identify(voice(1, noise: 0.05)) == "Priya")
        #expect(id.identify(voice(2)) == "Speaker 1")
        #expect(id.identify(voice(2, noise: 0.05)) == "Speaker 1")
        #expect(id.identify(voice(3)) == "Speaker 2")
    }

    @Test func ambiguousSavedVoicesAreNotNamed() {
        let a = voice(1), b = voice(1, noise: 0.02)
        var id = LiveSpeakerIdentifier(known: [KnownVoice(name: "A", vector: a), KnownVoice(name: "B", vector: b)])
        #expect(id.identify(voice(1, noise: 0.01)) == LiveSpeakerIdentifier.uncertain)
    }

    @Test func uncertainVoiceDoesNotCreateASpeaker() {
        // Distance between match threshold and new-speaker distance: neither named nor counted as someone new.
        let base = voice(1)
        let other = voice(4)
        var between: [Float]?
        for t in stride(from: Float(0.05), to: 1, by: 0.01) {
            let mix = zip(base, other).map { $0 * (1 - t) + $1 * t }
            let d = VoiceVector.cosineDistance(VoiceVector.normalized(mix), VoiceVector.normalized(base))
            if d > VoiceVector.matchThreshold + 0.02, d < VoiceVector.newSpeakerDistance - 0.02 { between = mix; break }
        }
        var id = LiveSpeakerIdentifier(known: [KnownVoice(name: "Priya", vector: base)])
        #expect(id.identify(try! #require(between)) == LiveSpeakerIdentifier.uncertain)
        #expect(id.identify(voice(2)) == "Speaker 1")
    }
}
