import Foundation
import GRDB
import Testing

import StenoAudio
import StenoModel
@testable import StenoStore

struct Fixture {
    let paths: AppPaths
    let db: StenoDatabase
    var sessions: SessionRepository { SessionRepository(db) }
    var runs: RunRepository { RunRepository(db) }

    init() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("steno-store-\(UUID().uuidString)")
        paths = try AppPaths(root: root)
        db = try StenoDatabase(paths: paths)
    }

    /// Session folder with a manifest and one 1 s mic part; returns the manifest.
    @discardableResult
    func makeSessionFolder(state: ManifestState, truncatedWAV: Bool = false) throws -> SessionManifest {
        let id = UUID()
        let dir = paths.sessionDirectory(id: id)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("raw"), withIntermediateDirectories: true)
        let wav = dir.appendingPathComponent("raw/mic-001.wav")
        let w = try WAVWriter(url: wav)
        let samples = [Float](repeating: 0.1, count: 16_000)
        try samples.withUnsafeBufferPointer { try w.append($0) }
        if !truncatedWAV { try w.close() }
        let m = SessionManifest(
            id: id, createdAt: Date(), mode: .inPerson, t0HostTime: 1, timebaseNumer: 1, timebaseDenom: 1, state: state,
            parts: [
                CapturePart(
                    index: 1, kind: .mic, file: "raw/mic-001.wav", firstHostTime: 1, offsetSamples: 0,
                    sampleCount: truncatedWAV ? 0 : 16_000, deviceUID: nil, deviceName: nil, nativeSampleRate: 48_000,
                    endReason: state == .captured ? .stopped : nil)
            ])
        try ManifestIO.write(m, to: ManifestIO.url(in: dir))
        return m
    }

    func jobs(_ sessionID: String) throws -> [JobRecord] {
        try db.writer.read { try JobRecord.filter(Column("session_id") == sessionID).fetchAll($0) }
    }
}

func document(speakers: [String] = ["S1", "S2"], text: String = "we should ship the new onboarding flow") -> TranscriptDocument {
    TranscriptDocument(
        runId: UUID(), asrModel: "test", diarizer: "test", diarizationError: nil,
        speakers: speakers.map { TranscriptSpeaker(id: $0, isMe: $0 == "Me") }, words: [],
        utterances: speakers.enumerated().map { i, s in
            Utterance(speaker: s, track: .imported, start: Double(i), end: Double(i) + 0.9, text: "\(text) \(i)")
        })
}

/// Waits until `condition` holds (polling the DB), failing after 5 s.
func eventually(_ condition: () throws -> Bool) async throws {
    for _ in 0..<500 {
        if try condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("condition not met within 5 s")
}

@Suite struct MigrationTests {
    @Test func migratesEmptyDatabase() throws {
        let f = try Fixture()
        let tables = try f.db.writer.read { try String.fetchAll($0, sql: "SELECT name FROM sqlite_master WHERE type='table'") }
        for t in ["session", "job", "run", "speaker", "utterance", "search"] { #expect(tables.contains(t)) }
    }
}

@Suite struct TransitionTests {
    @Test func allowedTransitionsSucceedAndOthersThrow() throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .recording)
        let id = m.id.uuidString
        try f.sessions.create(manifest: m)
        for next: SessionStatus in [.captured, .processing, .failed, .processing, .ready, .processing, .ready] {
            try f.sessions.transition(id: id, to: next)
        }
        #expect(throws: StoreError.invalidTransition(from: .ready, to: .captured)) {
            try f.sessions.transition(id: id, to: .captured)
        }
    }
}

@Suite(.serialized) struct JobRunnerTests {
    @Test func secondEnqueueIsNoOp() async throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .captured)
        try f.sessions.create(manifest: m)
        let runner = JobRunner(database: f.db, processor: { _, _ in document() })
        try await runner.enqueueProcess(sessionID: m.id.uuidString)
        try await runner.enqueueProcess(sessionID: m.id.uuidString)
        #expect(try f.jobs(m.id.uuidString).count == 1)
    }

    @Test func retriesThenSucceeds() async throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .captured)
        let id = m.id.uuidString
        try f.sessions.create(manifest: m)
        final class Counter: @unchecked Sendable {
            let lock = NSLock()
            var calls = 0
            func next() -> Int { lock.withLock { calls += 1; return calls } }
        }
        let counter = Counter()
        let runner = JobRunner(
            database: f.db,
            processor: { _, _ in
                if counter.next() <= 2 { throw CocoaError(.fileReadUnknown) }
                return document()
            }, retryDelay: { _ in .zero })
        try await runner.enqueueProcess(sessionID: id)
        await runner.start()
        try await eventually { try f.sessions.get(id: id)?.status == .ready }
        await runner.stop()
        let job = try #require(try f.jobs(id).first)
        #expect(job.state == .done)
        #expect(job.attempts == 2)
        #expect(counter.calls == 3)
        #expect(try f.sessions.get(id: id)?.currentRunId != nil)
    }

    @Test func threeFailuresFailTheSession() async throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .captured)
        let id = m.id.uuidString
        try f.sessions.create(manifest: m)
        let runner = JobRunner(
            database: f.db, processor: { _, _ in throw CocoaError(.fileReadCorruptFile) }, retryDelay: { _ in .zero })
        try await runner.enqueueProcess(sessionID: id)
        await runner.start()
        try await eventually { try f.sessions.get(id: id)?.status == .failed }
        await runner.stop()
        let session = try #require(try f.sessions.get(id: id))
        #expect(session.lastError == CocoaError(.fileReadCorruptFile).localizedDescription)
        #expect(try f.jobs(id).first?.state == .failed)
        #expect(try f.jobs(id).first?.attempts == 3)
    }

    @Test func pausedRunnerStartsNothing() async throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .captured)
        let id = m.id.uuidString
        try f.sessions.create(manifest: m)
        let runner = JobRunner(database: f.db, processor: { _, _ in document() })
        await runner.pause()
        await runner.start()
        try await runner.enqueueProcess(sessionID: id)
        try await Task.sleep(for: .milliseconds(100))
        #expect(try f.sessions.get(id: id)?.status == .captured)
        await runner.resume()
        try await eventually { try f.sessions.get(id: id)?.status == .ready }
        await runner.stop()
    }
}

@Suite struct RecoveryServiceTests {
    @Test func repairsRecordingSessionAndQueuesIt() async throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .recording, truncatedWAV: true)
        let id = m.id.uuidString
        try f.sessions.create(manifest: m)
        let runner = JobRunner(database: f.db, processor: { _, _ in document() })
        let report = try await RecoveryService(database: f.db, jobs: runner).run()
        #expect(report.repaired == 1)
        let session = try #require(try f.sessions.get(id: id))
        #expect(session.status == .captured)
        #expect(abs(session.durationSec - 1) < 0.001)
        #expect(try f.jobs(id).map(\.state) == [.queued])
        let manifest = try ManifestIO.read(from: ManifestIO.url(in: f.paths.sessionDirectory(id: m.id)))
        #expect(manifest.state == .captured)
        #expect(manifest.parts.last?.endReason == .crash)
        #expect(manifest.parts.last?.sampleCount == 16_000)
    }

    @Test func adoptsOrphanFolder() async throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .captured)
        let runner = JobRunner(database: f.db, processor: { _, _ in document() })
        let report = try await RecoveryService(database: f.db, jobs: runner).run()
        #expect(report.adopted == 1)
        #expect(try f.sessions.get(id: m.id.uuidString)?.status == .captured)
        #expect(try f.jobs(m.id.uuidString).count == 1)
    }

    @Test func rowWithoutFolderFails() async throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .captured)
        try f.sessions.create(manifest: m)
        try FileManager.default.removeItem(at: f.paths.sessionDirectory(id: m.id))
        let runner = JobRunner(database: f.db, processor: { _, _ in document() })
        try await RecoveryService(database: f.db, jobs: runner).run()
        let session = try #require(try f.sessions.get(id: m.id.uuidString))
        #expect(session.status == .failed)
        #expect(session.lastError == "Session folder missing")
    }

    @Test func requeuesInterruptedRunningJob() async throws {
        let f = try Fixture()
        let m = try f.makeSessionFolder(state: .captured)
        let id = m.id.uuidString
        try f.sessions.create(manifest: m)
        try f.sessions.transition(id: id, to: .processing)
        try await f.db.writer.write { db in
            try db.execute(
                sql: "INSERT INTO job (session_id, kind, state, created_at, updated_at) VALUES (?, 'process', 'running', 0, 0)",
                arguments: [id])
        }
        let runner = JobRunner(database: f.db, processor: { _, _ in document() })
        try await RecoveryService(database: f.db, jobs: runner).run()
        #expect(try f.jobs(id).map(\.state) == [.queued])
    }
}

@Suite struct SpeakerAndSearchTests {
    @Test func mergeAcrossRunsThrows() throws {
        let f = try Fixture()
        let a = try f.makeSessionFolder(state: .captured)
        let b = try f.makeSessionFolder(state: .captured)
        try f.sessions.create(manifest: a)
        try f.sessions.create(manifest: b)
        let docA = document()
        let docB = document()
        try f.runs.save(document: docA, sessionID: a.id.uuidString)
        try f.runs.save(document: docB, sessionID: b.id.uuidString)
        #expect(throws: StoreError.speakersInDifferentRuns) {
            try f.runs.mergeSpeaker(source: "\(docA.runId.uuidString):S1", into: "\(docB.runId.uuidString):S1")
        }
    }

    @Test func renameAndMergeWithinRun() throws {
        let f = try Fixture()
        let a = try f.makeSessionFolder(state: .captured)
        try f.sessions.create(manifest: a)
        let doc = document()
        try f.runs.save(document: doc, sessionID: a.id.uuidString)
        let run = doc.runId.uuidString
        try f.runs.renameSpeaker(id: "\(run):S1", displayName: "  Alex ")
        try f.runs.mergeSpeaker(source: "\(run):S2", into: "\(run):S1")
        let lines = try f.runs.utterances(runID: run)
        #expect(lines.count == 2)
        #expect(lines.allSatisfy { $0.speaker.name == "Alex" })
        #expect(try f.runs.speakers(runID: run).map(\.label) == ["S1"])
        try f.runs.renameSpeaker(id: "\(run):S1", displayName: "")
        #expect(try f.runs.speakers(runID: run).first?.displayName == nil)
    }

    @Test func searchFindsTranscriptPrefix() throws {
        let f = try Fixture()
        let a = try f.makeSessionFolder(state: .captured)
        let b = try f.makeSessionFolder(state: .captured)
        try f.sessions.create(manifest: a)
        try f.sessions.create(manifest: b)
        try f.runs.save(document: document(), sessionID: a.id.uuidString)
        try f.runs.save(document: document(text: "quarterly numbers"), sessionID: b.id.uuidString)
        try SearchIndex.reindex(f.db, sessionID: a.id.uuidString)
        try SearchIndex.reindex(f.db, sessionID: b.id.uuidString)
        #expect(try SearchIndex.search(f.db, "onboard") == [a.id.uuidString])
        #expect(try SearchIndex.search(f.db, "").count == 2)
        try f.sessions.setTitle(id: b.id.uuidString, title: "Roadmap review")
        #expect(try SearchIndex.search(f.db, "roadm") == [b.id.uuidString])
    }
}
