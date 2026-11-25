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

    /// Words of an utterance as shown in the transcript: its text split on whitespace.
    public static func words(of text: String) -> [String] {
        text.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// Hands words `range` of utterance `utteranceID` to `speakerID`. Words before and after stay with the original
    /// speaker as their own utterances. `wordTimes[i]` is the time span of word `i`; without it (or when the counts
    /// disagree) the times are spread over the utterance by word length. A speaker left with no utterances is removed.
    /// Microphone words that repeat what another utterance says at the same time are speaker echo: they are dropped
    /// instead of becoming a duplicate line.
    public func assignWords(
        utteranceID: Int64, range: Range<Int>, to speakerID: String, wordTimes: [ClosedRange<Double>]? = nil
    ) throws {
        try rewrite(utteranceID: utteranceID, range: range, to: speakerID, wordTimes: wordTimes)
    }

    /// Deletes words `range` of an utterance (for example speaker echo); the rest of the line stays.
    public func removeWords(utteranceID: Int64, range: Range<Int>, wordTimes: [ClosedRange<Double>]? = nil) throws {
        try rewrite(utteranceID: utteranceID, range: range, to: nil, wordTimes: wordTimes)
    }

    private func rewrite(utteranceID: Int64, range: Range<Int>, to speakerID: String?, wordTimes: [ClosedRange<Double>]?) throws {
        try db.writer.write { db in
            guard let u = try UtteranceRecord.fetchOne(db, key: utteranceID) else { throw StoreError.notFound("Utterance") }
            if let speakerID {
                guard let target = try SpeakerRecord.fetchOne(db, key: speakerID) else { throw StoreError.notFound("Speaker") }
                guard target.runId == u.runId else { throw StoreError.speakersInDifferentRuns }
            }
            let words = Self.words(of: u.text)
            guard !range.isEmpty, range.lowerBound >= 0, range.upperBound <= words.count else {
                throw StoreError.invalid("Choose at least one word of the line")
            }
            if speakerID == u.speakerId { return }
            let times = wordTimes?.count == words.count ? wordTimes! : Self.estimatedTimes(words, start: u.startSec, end: u.endSec)
            var pieces: [(speaker: String?, words: Range<Int>)] = []
            if range.lowerBound > 0 { pieces.append((u.speakerId, 0..<range.lowerBound)) }
            pieces.append((speakerID, range))
            if range.upperBound < words.count { pieces.append((u.speakerId, range.upperBound..<words.count)) }

            // Pieces that survive, with their time spans. The line keeps its original start and end.
            var kept: [UtteranceRecord] = []
            for (i, piece) in pieces.enumerated() {
                var record = u
                record.text = words[piece.words].joined(separator: " ")
                record.startSec = i == 0 ? u.startSec : times[piece.words.lowerBound].lowerBound
                record.endSec = i == pieces.count - 1 ? u.endSec : times[piece.words.upperBound - 1].upperBound
                guard let speaker = piece.speaker else { continue }
                record.speakerId = speaker
                if piece.words == range, speaker != u.speakerId, record.track == .mic,
                    try Self.isEcho(db, record)
                {
                    continue
                }
                kept.append(record)
            }
            if let first = kept.first {
                try first.update(db)
                for var record in kept.dropFirst() {
                    record.id = nil
                    try record.insert(db)
                }
            } else {
                try u.delete(db)
            }
            try db.execute(
                sql: """
                    DELETE FROM speaker WHERE run_id = ? AND is_me = 0
                    AND id NOT IN (SELECT speaker_id FROM utterance WHERE run_id = ?)
                    """, arguments: [u.runId, u.runId])
        }
    }

    /// True when most of the piece's words are said by non-microphone utterances at the same time (the same rule the
    /// merger uses to drop echo: 60% of the words, or all of them for a line under three words).
    private static func isEcho(_ db: Database, _ piece: UtteranceRecord) throws -> Bool {
        let tokens = echoTokens(piece.text)
        guard !tokens.isEmpty else { return false }
        let others = try UtteranceRecord.filter(
            Column("run_id") == piece.runId && Column("track") != TrackKind.mic.rawValue
                && Column("end_sec") > piece.startSec - 1 && Column("start_sec") < piece.endSec + 1
        ).fetchAll(db)
        var pool: [String: Int] = [:]
        for other in others { for t in echoTokens(other.text) { pool[t, default: 0] += 1 } }
        var shared = 0
        for t in tokens where pool[t, default: 0] > 0 {
            pool[t]! -= 1
            shared += 1
        }
        return tokens.count < 3 ? shared == tokens.count : Double(shared) / Double(tokens.count) >= 0.6
    }

    private static func echoTokens(_ text: String) -> [String] {
        text.lowercased().split(whereSeparator: \.isWhitespace).map { $0.filter { $0.isLetter || $0.isNumber || $0 == "'" } }
            .filter { !$0.isEmpty }
    }

    /// Adds a speaker named `displayName` to the run, for people the diarizer never separated.
    public func createSpeaker(runID: String, displayName: String) throws -> SpeakerRecord {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw StoreError.invalid("Enter a name for the new speaker") }
        return try db.writer.write { db in
            let existing = try SpeakerRecord.filter(Column("run_id") == runID).fetchAll(db)
            // "X" labels never clash with diarizer labels (S1, S2, …), whose voices are stored under those names.
            var n = 1
            while existing.contains(where: { $0.label == "X\(n)" }) { n += 1 }
            let speaker = SpeakerRecord(
                id: "\(runID):X\(n)", runId: runID, label: "X\(n)", displayName: name, isMe: false,
                colorIndex: (existing.map(\.colorIndex).max() ?? -1) + 1)
            try speaker.insert(db)
            return speaker
        }
    }

    static func estimatedTimes(_ words: [String], start: Double, end: Double) -> [ClosedRange<Double>] {
        let total = Double(words.reduce(0) { $0 + $1.count + 1 })
        var at = 0.0
        return words.map { word in
            let a = start + (end - start) * at / total
            at += Double(word.count + 1)
            return a...(start + (end - start) * at / total)
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
