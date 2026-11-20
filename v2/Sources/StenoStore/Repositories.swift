import Foundation
import GRDB
import StenoModel

public struct SessionRepository: Sendable {
    let db: StenoDatabase

    public init(_ db: StenoDatabase) { self.db = db }

    @discardableResult
    public func create(manifest: SessionManifest, title: String = "") throws -> SessionRecord {
        let record = SessionRecord(
            id: manifest.id.uuidString, title: title, createdAt: manifest.createdAt, endedAt: manifest.endedAt,
            mode: manifest.mode, status: manifest.state == .recording ? .recording : .captured,
            durationSec: manifest.durationSeconds, folder: manifest.id.uuidString)
        try db.writer.write { try record.insert($0) }
        return record
    }

    public func get(id: String) throws -> SessionRecord? {
        try db.writer.read { try SessionRecord.fetchOne($0, key: id) }
    }

    public func all() throws -> [SessionRecord] {
        try db.writer.read { try SessionRecord.order(Column("created_at").desc).fetchAll($0) }
    }

    /// All sessions, newest first; yields again on every change.
    public func observeAll() -> AsyncThrowingStream<[SessionRecord], Error> {
        let values = ValueObservation
            .tracking { try SessionRecord.order(Column("created_at").desc).fetchAll($0) }
            .values(in: db.writer)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await sessions in values { continuation.yield(sessions) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func transition(id: String, to next: SessionStatus, error: String? = nil) throws {
        try db.writer.write { try Self.transition($0, id: id, to: next, error: error) }
    }

    static func transition(_ db: Database, id: String, to next: SessionStatus, error: String?) throws {
        guard var session = try SessionRecord.fetchOne(db, key: id) else { throw StoreError.notFound("Session \(id)") }
        guard session.status.canTransition(to: next) else {
            throw StoreError.invalidTransition(from: session.status, to: next)
        }
        session.status = next
        session.lastError = error
        try session.update(db)
    }

    /// recording → captured with the final duration from the manifest.
    public func markCaptured(id: String, manifest: SessionManifest) throws {
        try db.writer.write { db in
            try Self.transition(db, id: id, to: .captured, error: nil)
            try db.execute(
                sql: "UPDATE session SET duration_sec = ?, ended_at = ? WHERE id = ?",
                arguments: [manifest.durationSeconds, manifest.endedAt?.timeIntervalSince1970, id])
        }
    }

    public func setTitle(id: String, title: String) throws {
        try db.writer.write { db in
            try db.execute(sql: "UPDATE session SET title = ? WHERE id = ?", arguments: [title, id])
            try SearchIndex.reindex(db, sessionID: id)
        }
    }

    public func setStarred(id: String, starred: Bool) throws {
        try db.writer.write { try $0.execute(sql: "UPDATE session SET starred = ? WHERE id = ?", arguments: [starred, id]) }
    }

    /// Deletes the row (cascading runs/jobs) and moves the folder to the Trash.
    public func delete(id: String) throws {
        let folder = try db.writer.write { db -> String? in
            let folder = try String.fetchOne(db, sql: "SELECT folder FROM session WHERE id = ?", arguments: [id])
            try db.execute(sql: "DELETE FROM search WHERE session_id = ?", arguments: [id])
            try db.execute(sql: "DELETE FROM session WHERE id = ?", arguments: [id])
            return folder
        }
        if let folder {
            let url = db.paths.sessionDirectory(folder: folder)
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.trashItem(at: url, resultingItemURL: nil)
            }
        }
    }
}

public struct RunRepository: Sendable {
    let db: StenoDatabase

    public init(_ db: StenoDatabase) { self.db = db }

    /// Inserts the run with its speakers and utterances and makes it the session's current run.
    public func save(document: TranscriptDocument, sessionID: String) throws {
        try db.writer.write { db in try Self.save(db, document: document, sessionID: sessionID) }
    }

    static func save(_ db: Database, document: TranscriptDocument, sessionID: String) throws {
        let runID = document.runId.uuidString
        try RunRecord(
            id: runID, sessionId: sessionID, createdAt: Date(), asrModel: document.asrModel, diarizer: document.diarizer,
            diarizationError: document.diarizationError
        ).insert(db)
        for (i, speaker) in document.speakers.enumerated() {
            try SpeakerRecord(
                id: "\(runID):\(speaker.id)", runId: runID, label: speaker.id, displayName: nil, isMe: speaker.isMe,
                colorIndex: i
            ).insert(db)
        }
        for u in document.utterances {
            let record = UtteranceRecord(
                id: nil, runId: runID, speakerId: "\(runID):\(u.speaker)", track: u.track, startSec: u.start,
                endSec: u.end, text: u.text)
            try record.insert(db)
        }
        try db.execute(sql: "UPDATE session SET current_run_id = ? WHERE id = ?", arguments: [runID, sessionID])
    }

    public func run(id: String) throws -> RunRecord? {
        try db.writer.read { try RunRecord.fetchOne($0, key: id) }
    }

    public func speakers(runID: String) throws -> [SpeakerRecord] {
        try db.writer.read {
            try SpeakerRecord.filter(Column("run_id") == runID).order(Column("color_index")).fetchAll($0)
        }
    }

    /// A manual rename (or clear) overrides any recognized name and unlinks the speaker from the voice library.
    public func renameSpeaker(id: String, displayName: String) throws {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        try db.writer.write { db in
            try db.execute(
                sql: "UPDATE speaker SET display_name = ?, known_speaker_id = NULL, auto_matched = 0 WHERE id = ?",
                arguments: [trimmed.isEmpty ? nil : trimmed, id])
        }
    }

    /// Reassigns every utterance of `source` to `target` and deletes `source`. Both must be in one run.
    public func mergeSpeaker(source: String, into target: String) throws {
        try db.writer.write { db in
            guard let a = try SpeakerRecord.fetchOne(db, key: source) else { throw StoreError.notFound("Speaker \(source)") }
            guard let b = try SpeakerRecord.fetchOne(db, key: target) else { throw StoreError.notFound("Speaker \(target)") }
            guard a.runId == b.runId else { throw StoreError.speakersInDifferentRuns }
            try db.execute(sql: "UPDATE utterance SET speaker_id = ? WHERE speaker_id = ?", arguments: [target, source])
            try db.execute(sql: "DELETE FROM speaker WHERE id = ?", arguments: [source])
        }
    }

    public func utterances(runID: String) throws -> [TranscriptLine] {
        try db.writer.read { db in
            let speakers = Dictionary(
                uniqueKeysWithValues: try SpeakerRecord.filter(Column("run_id") == runID).fetchAll(db).map { ($0.id, $0) })
            return try UtteranceRecord.filter(Column("run_id") == runID).order(Column("start_sec"), Column("id"))
                .fetchAll(db).compactMap { u in
                    guard let id = u.id, let speaker = speakers[u.speakerId] else { return nil }
                    return TranscriptLine(id: id, start: u.startSec, end: u.endSec, text: u.text, track: u.track, speaker: speaker)
                }
        }
    }
}

public enum SearchIndex {
    public static func reindex(_ db: Database, sessionID: String) throws {
        guard let session = try SessionRecord.fetchOne(db, key: sessionID) else { return }
        var notes = ""
        if try db.tableExists("note") {
            notes = try String.fetchOne(db, sql: "SELECT body_md FROM note WHERE session_id = ?", arguments: [sessionID]) ?? ""
        }
        var transcript = ""
        if let run = session.currentRunId {
            transcript = try String.fetchAll(
                db, sql: "SELECT text FROM utterance WHERE run_id = ? ORDER BY start_sec", arguments: [run]
            ).joined(separator: "\n")
        }
        try db.execute(sql: "DELETE FROM search WHERE session_id = ?", arguments: [sessionID])
        try db.execute(
            sql: "INSERT INTO search (session_id, title, notes, transcript) VALUES (?, ?, ?, ?)",
            arguments: [sessionID, session.title, notes, transcript])
    }

    public static func reindex(_ database: StenoDatabase, sessionID: String) throws {
        try database.writer.write { try reindex($0, sessionID: sessionID) }
    }

    /// Session ids matching every token as a prefix, best match first. Empty query → all sessions.
    public static func search(_ database: StenoDatabase, _ text: String) throws -> [String] {
        let tokens = text.split(whereSeparator: \.isWhitespace).map { token -> String in
            "\"" + token.replacingOccurrences(of: "\"", with: "\"\"") + "\"*"
        }
        return try database.writer.read { db in
            if tokens.isEmpty {
                return try String.fetchAll(db, sql: "SELECT id FROM session ORDER BY created_at DESC")
            }
            return try String.fetchAll(
                db, sql: "SELECT session_id FROM search WHERE search MATCH ? ORDER BY rank",
                arguments: [tokens.joined(separator: " ")])
        }
    }
}
