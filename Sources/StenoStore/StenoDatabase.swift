import Foundation
import GRDB
import StenoModel

public struct AppPaths: Sendable {
    public let root: URL

    public static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Stenographer", isDirectory: true)
    }

    public init(root: URL = AppPaths.defaultRoot) throws {
        self.root = root
        try FileManager.default.createDirectory(at: sessionsDirectory, withIntermediateDirectories: true)
    }

    public var sessionsDirectory: URL { root.appendingPathComponent("Sessions", isDirectory: true) }
    public var databaseURL: URL { root.appendingPathComponent("stenographer.sqlite") }
    /// Downloaded language models; created on first download.
    public var modelsDirectory: URL { root.appendingPathComponent("Models", isDirectory: true) }

    public func sessionDirectory(folder: String) -> URL {
        sessionsDirectory.appendingPathComponent(folder, isDirectory: true)
    }

    public func sessionDirectory(id: UUID) -> URL { sessionDirectory(folder: id.uuidString) }
}

public enum StoreError: Error, LocalizedError, Equatable {
    case invalidTransition(from: SessionStatus, to: SessionStatus)
    case notFound(String)
    case speakersInDifferentRuns
    case noVoiceEmbedding

    public var errorDescription: String? {
        switch self {
        case .noVoiceEmbedding: "No voice sample is available for this speaker"
        case .invalidTransition(let from, let to): "Invalid session transition \(from.rawValue) → \(to.rawValue)"
        case .notFound(let what): "\(what) not found"
        case .speakersInDifferentRuns: "Speakers belong to different transcripts"
        }
    }
}

public final class StenoDatabase: Sendable {
    public let writer: any DatabaseWriter
    public let paths: AppPaths

    public init(paths: AppPaths) throws {
        self.paths = paths
        var config = Configuration()
        config.foreignKeysEnabled = true
        writer = try DatabasePool(path: paths.databaseURL.path, configuration: config)
        try Self.migrator.migrate(writer)
    }

    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(
                sql: """
                    CREATE TABLE session (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, ended_at REAL,
                      mode TEXT NOT NULL CHECK(mode IN ('call','inPerson','systemOnly','import')),
                      status TEXT NOT NULL CHECK(status IN ('recording','captured','processing','ready','failed')),
                      duration_sec REAL NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, folder TEXT NOT NULL UNIQUE,
                      last_error TEXT, current_run_id TEXT);
                    CREATE TABLE job (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                      kind TEXT NOT NULL CHECK(kind IN ('process')), state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed')),
                      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
                    CREATE UNIQUE INDEX job_one_active ON job(session_id) WHERE state IN ('queued','running');
                    CREATE TABLE run (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, created_at REAL NOT NULL,
                      asr_model TEXT NOT NULL, diarizer TEXT NOT NULL, diarization_error TEXT);
                    CREATE TABLE speaker (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, label TEXT NOT NULL,
                      display_name TEXT, is_me INTEGER NOT NULL DEFAULT 0, color_index INTEGER NOT NULL);
                    CREATE TABLE utterance (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
                      speaker_id TEXT NOT NULL REFERENCES speaker(id) ON DELETE CASCADE, track TEXT NOT NULL, start_sec REAL NOT NULL, end_sec REAL NOT NULL, text TEXT NOT NULL);
                    CREATE INDEX utterance_run_start ON utterance(run_id, start_sec);
                    CREATE VIRTUAL TABLE search USING fts5(session_id UNINDEXED, title, notes, transcript, tokenize='unicode61');
                    """)
        }
        migrator.registerMigration("v2") { db in
            try db.execute(
                sql: """
                    CREATE TABLE note (session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, body_md TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL);
                    CREATE TABLE generated_note (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                      template_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, body_md TEXT NOT NULL, created_at REAL NOT NULL);
                    """)
        }
        migrator.registerMigration("v3") { db in
            try db.execute(
                sql: """
                    CREATE TABLE known_speaker (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, centroid BLOB NOT NULL,
                      sample_count INTEGER NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
                    CREATE UNIQUE INDEX known_speaker_name ON known_speaker(name COLLATE NOCASE);
                    ALTER TABLE speaker ADD COLUMN known_speaker_id TEXT REFERENCES known_speaker(id) ON DELETE SET NULL;
                    ALTER TABLE speaker ADD COLUMN auto_matched INTEGER NOT NULL DEFAULT 0;
                    """)
        }
        migrator.registerMigration("v4") { db in
            // Formatted (RTF) human notes. `body_md` stays the plain text used by search, export and prompts.
            try db.execute(sql: "ALTER TABLE note ADD COLUMN body_rtf BLOB")
        }
        return migrator
    }
}

/// Shared GRDB coding conventions: snake_case columns, dates as Unix seconds.
public protocol StenoRecord: Codable, FetchableRecord, PersistableRecord, Sendable {}

extension StenoRecord {
    public static var databaseColumnDecodingStrategy: DatabaseColumnDecodingStrategy { .convertFromSnakeCase }
    public static var databaseColumnEncodingStrategy: DatabaseColumnEncodingStrategy { .convertToSnakeCase }
    public static func databaseDateEncodingStrategy(for column: String) -> DatabaseDateEncodingStrategy {
        .timeIntervalSince1970
    }
    public static func databaseDateDecodingStrategy(for column: String) -> DatabaseDateDecodingStrategy {
        .timeIntervalSince1970
    }
}
