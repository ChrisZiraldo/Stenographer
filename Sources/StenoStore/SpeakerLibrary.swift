import Foundation
import GRDB
import StenoModel

/// A person whose voice the app recognizes in future meetings. `centroid` is a unit-length speaker
/// embedding (Float32, little-endian) averaged over `sampleCount` confirmed meetings.
public struct KnownSpeakerRecord: StenoRecord, Identifiable, Equatable, Hashable {
    public static let databaseTableName = "known_speaker"
    public var id: String
    public var name: String
    public var centroid: Data
    public var sampleCount: Int
    public var createdAt: Date
    public var updatedAt: Date
}

public struct VoiceAssignment: Sendable, Equatable {
    public var label: String
    public var knownID: String
    public var distance: Float
}

public enum VoiceMatcher {
    /// Assigns library voices to diarized speakers. Each label and each library voice is used at most once;
    /// the closest pairs win.
    public static func assign(embeddings: [String: [Float]], known: [KnownSpeakerRecord]) -> [VoiceAssignment] {
        let library = known.map { ($0.id, VoiceVector.vector($0.centroid)) }
        var candidates: [VoiceAssignment] = []
        for (label, embedding) in embeddings {
            let ranked = library.map { ($0.0, VoiceVector.cosineDistance(embedding, $0.1)) }.sorted { $0.1 < $1.1 }
            guard let best = ranked.first, best.1 <= VoiceVector.matchThreshold else { continue }
            if ranked.count > 1, ranked[1].1 - best.1 < VoiceVector.ambiguityMargin { continue }
            candidates.append(VoiceAssignment(label: label, knownID: best.0, distance: best.1))
        }
        candidates.sort { ($0.distance, $0.label) < ($1.distance, $1.label) }
        var usedLabels = Set<String>(), usedKnown = Set<String>()
        var result: [VoiceAssignment] = []
        for c in candidates where !usedLabels.contains(c.label) && !usedKnown.contains(c.knownID) {
            usedLabels.insert(c.label)
            usedKnown.insert(c.knownID)
            result.append(c)
        }
        return result
    }
}

/// A remembered person with their meeting history, counted over each session's current transcript.
public struct SpeakerSummary: Identifiable, Equatable, Sendable {
    public var known: KnownSpeakerRecord
    public var meetingCount: Int
    public var speakingSeconds: Double
    public var lastMet: Date?
    public var id: String { known.id }
}

public struct SpeakerMeeting: Identifiable, Equatable, Sendable {
    public var session: SessionRecord
    public var speakingSeconds: Double
    public var id: String { session.id }
}

/// Persistent voice library: remembers named speakers and labels them automatically in later transcripts.
public struct SpeakerLibrary: Sendable {
    let db: StenoDatabase

    public init(_ db: StenoDatabase) { self.db = db }

    /// Every remembered person, most-met first, with meeting count, total speaking time and last meeting.
    public func summaries() throws -> [SpeakerSummary] {
        try db.writer.read { db in
            try Row.fetchAll(
                db,
                sql: """
                    SELECT k.*, COUNT(DISTINCT s.id) AS meetings, COALESCE(SUM(u.end_sec - u.start_sec), 0) AS spoken,
                           MAX(s.created_at) AS last_met
                    FROM known_speaker k
                    LEFT JOIN speaker sp ON sp.known_speaker_id = k.id
                    LEFT JOIN session s ON s.current_run_id = sp.run_id
                    LEFT JOIN utterance u ON u.speaker_id = sp.id AND s.id IS NOT NULL
                    GROUP BY k.id
                    ORDER BY meetings DESC, k.name COLLATE NOCASE
                    """
            ).map { row in
                SpeakerSummary(
                    known: try KnownSpeakerRecord(row: row), meetingCount: row["meetings"], speakingSeconds: row["spoken"],
                    lastMet: (row["last_met"] as Double?).map { Date(timeIntervalSince1970: $0) })
            }
        }
    }

    /// Sessions whose current transcript has this person, newest first.
    public func meetings(of knownID: String) throws -> [SpeakerMeeting] {
        try db.writer.read { db in
            try Row.fetchAll(
                db,
                sql: """
                    SELECT s.*, COALESCE(SUM(u.end_sec - u.start_sec), 0) AS spoken
                    FROM speaker sp
                    JOIN session s ON s.current_run_id = sp.run_id
                    LEFT JOIN utterance u ON u.speaker_id = sp.id
                    WHERE sp.known_speaker_id = ?
                    GROUP BY s.id
                    ORDER BY s.created_at DESC
                    """,
                arguments: [knownID]
            ).map { SpeakerMeeting(session: try SessionRecord(row: $0), speakingSeconds: $0["spoken"]) }
        }
    }

    public func all() throws -> [KnownSpeakerRecord] {
        try db.writer.read { try KnownSpeakerRecord.order(sql: "name COLLATE NOCASE").fetchAll($0) }
    }

    /// Adds `embedding` to the voice named `name` (case-insensitive), creating it if needed. The centroid is the
    /// normalized mean of all remembered embeddings; an embedding of a different size (model change) restarts it.
    @discardableResult
    public func remember(name: String, embedding: [Float]) throws -> KnownSpeakerRecord {
        try db.writer.write { try Self.remember($0, name: name, embedding: embedding) }
    }

    static func remember(_ db: Database, name: String, embedding: [Float]) throws -> KnownSpeakerRecord {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let unit = VoiceVector.normalized(embedding)
        guard !trimmed.isEmpty, !unit.isEmpty, unit.contains(where: { $0 != 0 }) else {
            throw StoreError.noVoiceEmbedding
        }
        let now = Date()
        if var existing = try KnownSpeakerRecord.filter(sql: "name = ? COLLATE NOCASE", arguments: [trimmed]).fetchOne(db) {
            let old = VoiceVector.vector(existing.centroid)
            if old.count == unit.count {
                let weight = Float(existing.sampleCount)
                existing.centroid = VoiceVector.data(VoiceVector.normalized(zip(old, unit).map { $0 * weight + $1 }))
                existing.sampleCount += 1
            } else {
                existing.centroid = VoiceVector.data(unit)
                existing.sampleCount = 1
            }
            existing.updatedAt = now
            try existing.update(db)
            return existing
        }
        let record = KnownSpeakerRecord(
            id: UUID().uuidString, name: trimmed, centroid: VoiceVector.data(unit), sampleCount: 1, createdAt: now,
            updatedAt: now)
        try record.insert(db)
        return record
    }

    /// True when the speaker's run kept a voice embedding for it (needs a diarized run).
    public func canRemember(speakerID: String) -> Bool {
        (try? db.writer.read { try Self.embedding($0, paths: db.paths, speakerID: speakerID) }) != nil
    }

    /// Saves the voice of a transcript speaker under `name` and links the speaker to it.
    @discardableResult
    public func rememberVoice(ofSpeaker speakerID: String, as name: String) throws -> KnownSpeakerRecord {
        let paths = self.db.paths
        return try db.writer.write { db in
            guard let embedding = try Self.embedding(db, paths: paths, speakerID: speakerID) else { throw StoreError.noVoiceEmbedding }
            let known = try Self.remember(db, name: name, embedding: embedding)
            try db.execute(
                sql: "UPDATE speaker SET known_speaker_id = ?, auto_matched = 0 WHERE id = ?", arguments: [known.id, speakerID])
            return known
        }
    }

    public func rename(id: String, to name: String) throws {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try db.writer.write { db in
            try db.execute(
                sql: "UPDATE known_speaker SET name = ?, updated_at = ? WHERE id = ?",
                arguments: [trimmed, Date().timeIntervalSince1970, id])
            try db.execute(sql: "UPDATE speaker SET display_name = ? WHERE known_speaker_id = ?", arguments: [trimmed, id])
        }
    }

    /// Forgets a voice. Names already written into transcripts stay; they are just no longer linked.
    public func delete(id: String) throws {
        try db.writer.write { try $0.execute(sql: "DELETE FROM known_speaker WHERE id = ?", arguments: [id]) }
    }

    /// Names the unnamed speakers of a run whose embeddings match a library voice. Returns how many were named.
    @discardableResult
    public func label(runID: String) throws -> Int {
        let paths = self.db.paths
        return try db.writer.write { db in
            try Self.label(db, runID: runID, embeddings: try Self.embeddings(db, paths: paths, runID: runID))
        }
    }

    /// Runs recognition over the current transcript of every session. Returns how many speakers were named.
    @discardableResult
    public func labelAllSessions() throws -> Int {
        let paths = self.db.paths
        return try db.writer.write { db in
            let runs = try String.fetchAll(db, sql: "SELECT current_run_id FROM session WHERE current_run_id IS NOT NULL")
            return try runs.reduce(0) {
                $0 + (try Self.label(db, runID: $1, embeddings: try Self.embeddings(db, paths: paths, runID: $1)))
            }
        }
    }

    static func label(_ db: Database, runID: String, embeddings: [String: [Float]]) throws -> Int {
        guard !embeddings.isEmpty else { return 0 }
        let speakers = try SpeakerRecord.filter(Column("run_id") == runID).fetchAll(db)
        let taken = Set(speakers.compactMap { $0.displayName?.lowercased() })
        let known = try KnownSpeakerRecord.fetchAll(db).filter { !taken.contains($0.name.lowercased()) }
        let unnamed = Dictionary(
            uniqueKeysWithValues: speakers.filter { $0.displayName == nil && !$0.isMe }.map { ($0.label, $0.id) })
        let candidates = embeddings.filter { unnamed[$0.key] != nil }
        guard !candidates.isEmpty, !known.isEmpty else { return 0 }
        let names = Dictionary(uniqueKeysWithValues: known.map { ($0.id, $0.name) })
        let assignments = VoiceMatcher.assign(embeddings: candidates, known: known)
        for a in assignments {
            try db.execute(
                sql: "UPDATE speaker SET display_name = ?, known_speaker_id = ?, auto_matched = 1 WHERE id = ?",
                arguments: [names[a.knownID], a.knownID, unnamed[a.label]])
        }
        return assignments.count
    }

    private struct DiarizationFile: Decodable { var speakerDatabase: [String: [Float]]? }

    /// Per-speaker embeddings the diarizer saved next to the run's other artifacts, keyed by transcript label.
    static func embeddings(_ db: Database, paths: AppPaths, runID: String) throws -> [String: [Float]] {
        guard
            let folder = try String.fetchOne(
                db, sql: "SELECT session.folder FROM run JOIN session ON session.id = run.session_id WHERE run.id = ?",
                arguments: [runID])
        else { return [:] }
        return embeddings(sessionDir: paths.sessionDirectory(folder: folder), runID: runID)
    }

    static func embeddings(sessionDir: URL, runID: String) -> [String: [Float]] {
        let url = sessionDir.appendingPathComponent("runs/\(runID)/diarization.json")
        guard FileManager.default.fileExists(atPath: url.path),
            let file = try? StenoJSON.read(DiarizationFile.self, from: url)
        else { return [:] }
        return file.speakerDatabase ?? [:]
    }

    static func embedding(_ db: Database, paths: AppPaths, speakerID: String) throws -> [Float]? {
        guard let speaker = try SpeakerRecord.fetchOne(db, key: speakerID), !speaker.isMe else { return nil }
        return try embeddings(db, paths: paths, runID: speaker.runId)[speaker.label]
    }
}
