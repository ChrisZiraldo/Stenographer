import Foundation
import GRDB

public struct GeneratedNoteRecord: StenoRecord, Identifiable, Equatable, Hashable {
    public static let databaseTableName = "generated_note"
    public var id: String
    public var sessionId: String
    public var templateId: String
    public var provider: String
    public var model: String
    public var bodyMd: String
    public var createdAt: Date

    public init(
        id: String = UUID().uuidString, sessionId: String, templateId: String, provider: String, model: String,
        bodyMd: String, createdAt: Date = Date()
    ) {
        self.id = id
        self.sessionId = sessionId
        self.templateId = templateId
        self.provider = provider
        self.model = model
        self.bodyMd = bodyMd
        self.createdAt = createdAt
    }
}

public struct NoteRepository: Sendable {
    let db: StenoDatabase

    public init(_ db: StenoDatabase) { self.db = db }

    public func body(sessionID: String) throws -> String {
        try db.writer.read {
            try String.fetchOne($0, sql: "SELECT body_md FROM note WHERE session_id = ?", arguments: [sessionID]) ?? ""
        }
    }

    /// Upserts the human notes and reindexes the session.
    public func save(sessionID: String, body: String) throws {
        try db.writer.write { db in
            try db.execute(
                sql: """
                    INSERT INTO note (session_id, body_md, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET body_md = excluded.body_md, updated_at = excluded.updated_at
                    """,
                arguments: [sessionID, body, Date().timeIntervalSince1970])
            try SearchIndex.reindex(db, sessionID: sessionID)
        }
    }

    public func insertGenerated(_ note: GeneratedNoteRecord) throws {
        try db.writer.write { try note.insert($0) }
    }

    /// Newest first.
    public func generated(sessionID: String) throws -> [GeneratedNoteRecord] {
        try db.writer.read {
            try GeneratedNoteRecord.filter(Column("session_id") == sessionID).order(Column("created_at").desc).fetchAll($0)
        }
    }
}
