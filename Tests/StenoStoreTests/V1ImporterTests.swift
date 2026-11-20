import Foundation
import GRDB
import Testing

import StenoAudio
import StenoModel
@testable import StenoStore

@Suite struct V1ImporterTests {
    let v1Root = FileManager.default.temporaryDirectory.appendingPathComponent("steno-v1-\(UUID().uuidString)")
    let withAudio = "5aeb3a9d-8665-42ec-af80-d217d2192975"
    let noAudio = "3dc9b9c0-28c2-4662-b156-5d912d17986c"

    func writeWAV(folder: String, seconds: Int) throws {
        let dir = v1Root.appendingPathComponent("recordings/\(folder)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let w = try WAVWriter(url: dir.appendingPathComponent("recording.wav"))
        let samples = [Float](repeating: 0.1, count: 16_000 * seconds)
        try samples.withUnsafeBufferPointer { try w.append($0) }
        try w.close()
    }

    func makeV1() throws {
        try writeWAV(folder: "2026-06-25T09-31-40", seconds: 2)
        try writeWAV(folder: "2026-07-01T10-00-00", seconds: 1)
        let queue = try DatabaseQueue(path: v1Root.appendingPathComponent("stenographer.db").path)
        try queue.write { db in
            try db.execute(sql: """
                CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, status TEXT, folder_path TEXT,
                  audio_path TEXT, duration_ms INTEGER, starred INTEGER, template_type TEXT);
                CREATE TABLE notes (meeting_id TEXT PRIMARY KEY, human_doc_text TEXT, enhanced_md TEXT, final_doc_text TEXT);
                """)
            try db.execute(
                sql: "INSERT INTO meetings VALUES (?, 'Kit 1:1', 1782394279391, 'done', '2026-06-25T09-31-40', NULL, 2000, 1, NULL)",
                arguments: [withAudio])
            try db.execute(
                sql: "INSERT INTO meetings VALUES (?, 'Untitled Meeting', 1782327828, 'recording', 'missing', NULL, NULL, 0, NULL)",
                arguments: [noAudio])
            try db.execute(
                sql: "INSERT INTO notes VALUES (?, 'my notes', 'enhanced', 'final')", arguments: [withAudio])
            try db.execute(sql: "INSERT INTO notes VALUES (?, '', 'only enhanced', '')", arguments: [noAudio])
        }
    }

    @Test func importerReadsToEndOfFile() throws {
        try writeWAV(folder: "x", seconds: 3)
        let dir = v1Root.appendingPathComponent("out")
        let m = try Importer.importAudio(
            from: v1Root.appendingPathComponent("recordings/x/recording.wav"), into: dir, id: UUID())
        #expect(m.parts.first?.sampleCount == 48_000)
    }

    @Test func importsMeetingsNotesAndOrphansIdempotently() throws {
        try makeV1()
        let f = try Fixture()
        let importer = V1Importer(database: f.db, v1Root: v1Root)
        let report = try importer.run()
        #expect(report.summary == "imported: 2, skipped: 0, withoutAudio: 1, orphanFolders: 1")
        #expect(report.toProcess.count == 2)

        let a = try #require(try f.sessions.get(id: withAudio.uppercased()))
        #expect(a.status == .captured)
        #expect(a.mode == .imported)
        #expect(a.starred)
        #expect(a.title == "Kit 1:1")
        #expect(abs(a.createdAt.timeIntervalSince1970 - 1782394279.391) < 0.01)
        #expect(abs(a.durationSec - 2) < 0.01)
        #expect(try NoteRepository(f.db).body(sessionID: a.id) == "my notes")
        #expect(try NoteRepository(f.db).generated(sessionID: a.id).map(\.templateId) == ["v1-final"])

        let b = try #require(try f.sessions.get(id: noAudio.uppercased()))
        #expect(b.status == .ready)
        #expect(b.title == "")
        #expect(b.createdAt.timeIntervalSince1970 == 1782327828)
        #expect(try NoteRepository(f.db).generated(sessionID: b.id).map(\.bodyMd) == ["only enhanced"])
        #expect(FileManager.default.fileExists(atPath: ManifestIO.url(in: f.paths.sessionDirectory(folder: b.folder)).path))

        let orphanID = V1Importer.orphanID(folder: "2026-07-01T10-00-00")
        #expect(orphanID == V1Importer.orphanID(folder: "2026-07-01T10-00-00"))
        #expect(orphanID.uuidString.dropFirst(14).first == "4")
        let orphan = try #require(try f.sessions.get(id: orphanID.uuidString))
        #expect(orphan.title == "Imported recording 2026-07-01T10-00-00")
        #expect(orphan.createdAt == V1Importer.folderDate("2026-07-01T10-00-00"))

        let again = try importer.run()
        #expect(again.summary == "imported: 0, skipped: 2, withoutAudio: 0, orphanFolders: 0")
        for session in try f.sessions.all() {
            #expect(FileManager.default.fileExists(atPath: f.paths.sessionDirectory(folder: session.folder).path))
        }
    }
}
