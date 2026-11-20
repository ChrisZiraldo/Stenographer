import Foundation
import GRDB
import Testing

import StenoModel
@testable import StenoStore

/// Deterministic 32-dim "voice": different seeds are far apart, `noise` perturbs a voice slightly.
private func voice(_ seed: Int, noise: Float = 0) -> [Float] {
    (0..<32).map { i in sin(Float(seed * 31 + i * (seed + 3))) + noise * cos(Float(i * 7)) }
}

private func known(_ name: String, _ embedding: [Float]) -> KnownSpeakerRecord {
    KnownSpeakerRecord(
        id: name, name: name, centroid: VoiceVector.data(VoiceVector.normalized(embedding)), sampleCount: 1,
        createdAt: Date(), updatedAt: Date())
}

@Suite struct VoiceMatcherTests {
    @Test func voicesAreSeparatedBySeed() {
        #expect(VoiceVector.cosineDistance(voice(1), voice(2)) > 0.5)
        #expect(VoiceVector.cosineDistance(voice(1), voice(1, noise: 0.05)) < VoiceVector.matchThreshold)
    }

    @Test func matchesOnlyWithinThreshold() {
        let library = [known("Alex", voice(1))]
        let hit = VoiceMatcher.assign(embeddings: ["S1": voice(1, noise: 0.05), "S2": voice(2)], known: library)
        #expect(hit == [VoiceAssignment(label: "S1", knownID: "Alex", distance: hit.first?.distance ?? 0)])
    }

    @Test func oneLibraryVoiceNamesOnlyTheClosestSpeaker() {
        let library = [known("Alex", voice(1))]
        let result = VoiceMatcher.assign(embeddings: ["S1": voice(1, noise: 0.2), "S2": voice(1, noise: 0.02)], known: library)
        #expect(result.map(\.label) == ["S2"])
    }

    @Test func nearIdenticalLibraryVoicesStayUnnamed() {
        let library = [known("Alex", voice(1)), known("Alexa", voice(1, noise: 0.01))]
        #expect(VoiceMatcher.assign(embeddings: ["S1": voice(1)], known: library).isEmpty)
    }

    @Test func mismatchedDimensionsNeverMatch() {
        #expect(VoiceMatcher.assign(embeddings: ["S1": [1, 0, 0]], known: [known("Alex", voice(1))]).isEmpty)
    }
}

@Suite struct SpeakerLibraryTests {
    /// A ready session whose run carries speaker embeddings, like a finished diarized job.
    @discardableResult
    private func readySession(_ f: Fixture, voices: [String: [Float]]) throws -> (sessionID: String, runID: String) {
        let manifest = try f.makeSessionFolder(state: .captured)
        let session = try f.sessions.create(manifest: manifest)
        let doc = document(speakers: voices.keys.sorted())
        try f.sessions.transition(id: session.id, to: .processing)
        try f.runs.save(document: doc, sessionID: session.id)
        try f.sessions.transition(id: session.id, to: .ready)
        try writeVoices(voices, sessionDir: f.paths.sessionDirectory(folder: session.folder), runID: doc.runId)
        return (session.id, doc.runId.uuidString)
    }

    private func writeVoices(_ voices: [String: [Float]], sessionDir: URL, runID: UUID) throws {
        let dir = sessionDir.appendingPathComponent("runs/\(runID.uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let json = try JSONEncoder().encode(["speakerDatabase": voices])
        try json.write(to: dir.appendingPathComponent("diarization.json"))
    }

    @Test func rememberingTheSameNameAveragesTheVoice() throws {
        let f = try Fixture()
        let library = SpeakerLibrary(f.db)
        try library.remember(name: "Alex", embedding: voice(1))
        let merged = try library.remember(name: "alex", embedding: voice(1, noise: 0.1))
        #expect(try library.all().count == 1)
        #expect(merged.sampleCount == 2)
        let centroid = VoiceVector.vector(merged.centroid)
        #expect(abs(centroid.reduce(0) { $0 + $1 * $1 } - 1) < 1e-4)
        #expect(VoiceVector.cosineDistance(centroid, voice(1)) < 0.05)
    }

    @Test func recognizesARememberedVoiceInOtherSessionsEvenWhenLabelsDiffer() throws {
        let f = try Fixture()
        let library = SpeakerLibrary(f.db)
        let a = try readySession(f, voices: ["S1": voice(1), "S2": voice(2)])
        let b = try readySession(f, voices: ["S1": voice(2, noise: 0.05), "S2": voice(1, noise: 0.05)])

        try f.runs.renameSpeaker(id: "\(a.runID):S1", displayName: "Alex")
        try library.rememberVoice(ofSpeaker: "\(a.runID):S1", as: "Alex")
        #expect(try library.labelAllSessions() == 1)

        let speakers = try f.runs.speakers(runID: b.runID)
        let alex = try #require(speakers.first { $0.label == "S2" })
        #expect(alex.displayName == "Alex")
        #expect(alex.autoMatched)
        #expect(alex.knownSpeakerId != nil)
        #expect(speakers.first { $0.label == "S1" }?.displayName == nil)
        // The already-named source speaker is left alone and nobody is named twice.
        #expect(try f.runs.speakers(runID: a.runID).filter { $0.displayName == "Alex" }.count == 1)
        #expect(try library.labelAllSessions() == 0)
    }

    @Test func summarizesMeetingHistoryPerPerson() throws {
        let f = try Fixture()
        let library = SpeakerLibrary(f.db)
        let a = try readySession(f, voices: ["S1": voice(1), "S2": voice(2)])
        let b = try readySession(f, voices: ["S1": voice(2, noise: 0.05), "S2": voice(1, noise: 0.05)])
        try library.rememberVoice(ofSpeaker: "\(a.runID):S1", as: "Alex")
        try library.rememberVoice(ofSpeaker: "\(a.runID):S2", as: "Priya")
        try library.labelAllSessions()

        let summaries = try library.summaries()
        let alex = try #require(summaries.first { $0.known.name == "Alex" })
        #expect(summaries.map(\.known.name).sorted() == ["Alex", "Priya"])
        #expect(alex.meetingCount == 2)
        #expect(abs(alex.speakingSeconds - 1.8) < 1e-6)
        #expect(alex.lastMet != nil)

        let meetings = try library.meetings(of: alex.id)
        #expect(meetings.map(\.session.id) == [b.sessionID, a.sessionID])
        #expect(meetings.allSatisfy { abs($0.speakingSeconds - 0.9) < 1e-6 })
    }

    @Test func personWithNoLinkedMeetingsStillListed() throws {
        let f = try Fixture()
        let library = SpeakerLibrary(f.db)
        try library.remember(name: "Alex", embedding: voice(1))
        let summary = try #require(try library.summaries().first)
        #expect(summary.meetingCount == 0)
        #expect(summary.speakingSeconds == 0)
        #expect(summary.lastMet == nil)
        #expect(try library.meetings(of: summary.id).isEmpty)
    }

    @Test func manualRenameOverridesRecognition() throws {
        let f = try Fixture()
        let library = SpeakerLibrary(f.db)
        let a = try readySession(f, voices: ["S1": voice(1)])
        try library.rememberVoice(ofSpeaker: "\(a.runID):S1", as: "Alex")
        let b = try readySession(f, voices: ["S1": voice(1, noise: 0.03)])
        #expect(try library.label(runID: b.runID) == 1)

        try f.runs.renameSpeaker(id: "\(b.runID):S1", displayName: "Sam")
        let speaker = try #require(try f.runs.speakers(runID: b.runID).first)
        #expect(speaker.displayName == "Sam")
        #expect(!speaker.autoMatched)
        #expect(speaker.knownSpeakerId == nil)
    }

    @Test func renamingAndForgettingAVoice() throws {
        let f = try Fixture()
        let library = SpeakerLibrary(f.db)
        let a = try readySession(f, voices: ["S1": voice(1)])
        let alex = try library.rememberVoice(ofSpeaker: "\(a.runID):S1", as: "Alex")
        try library.rename(id: alex.id, to: "Alexander")
        #expect(try f.runs.speakers(runID: a.runID).first?.displayName == "Alexander")
        try library.delete(id: alex.id)
        #expect(try library.all().isEmpty)
        #expect(try f.runs.speakers(runID: a.runID).first?.knownSpeakerId == nil)
    }

    @Test func speakersWithoutAVoiceSampleCannotBeRemembered() throws {
        let f = try Fixture()
        let library = SpeakerLibrary(f.db)
        let a = try readySession(f, voices: ["S1": voice(1)])
        #expect(library.canRemember(speakerID: "\(a.runID):S1"))
        #expect(!library.canRemember(speakerID: "\(a.runID):S9"))
        #expect(throws: StoreError.noVoiceEmbedding) { try library.rememberVoice(ofSpeaker: "\(a.runID):S9", as: "Alex") }
    }
}

@Suite(.serialized) struct JobRunnerRecognitionTests {
    @Test func finishedJobComesBackWithKnownSpeakersAlreadyNamed() async throws {
        let f = try Fixture()
        let library = SpeakerLibrary(f.db)
        try library.remember(name: "Priya", embedding: voice(3))
        let m = try f.makeSessionFolder(state: .captured)
        let id = m.id.uuidString
        try f.sessions.create(manifest: m)
        let runner = JobRunner(
            database: f.db,
            processor: { sessionDir, _ in
                let doc = document(speakers: ["S1", "S2"])
                let dir = sessionDir.appendingPathComponent("runs/\(doc.runId.uuidString)")
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let voices = ["S1": voice(5), "S2": voice(3, noise: 0.04)]
                try JSONEncoder().encode(["speakerDatabase": voices]).write(to: dir.appendingPathComponent("diarization.json"))
                return doc
            })
        try await runner.enqueueProcess(sessionID: id)
        await runner.start()
        try await eventually { try f.sessions.get(id: id)?.status == .ready }
        await runner.stop()

        let runID = try #require(try f.sessions.get(id: id)?.currentRunId)
        let names = Dictionary(uniqueKeysWithValues: try f.runs.speakers(runID: runID).map { ($0.label, $0.displayName) })
        #expect(names["S2"] == "Priya")
        #expect(names["S1"] == .some(nil))
    }
}
