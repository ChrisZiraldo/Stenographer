import CryptoKit
import Foundation
import GRDB
import StenoAudio
import StenoModel

/// Imports Stenographer v1 meetings (DB rows, notes, audio) and orphan recording folders. Idempotent by session id.
public struct V1Importer: Sendable {
    public struct Report: Sendable, Codable, Equatable {
        public var imported = 0
        public var skipped = 0
        public var withoutAudio = 0
        public var orphanFolders = 0
        /// Sessions left `captured` that need a process job.
        public var toProcess: [String] = []

        public var summary: String {
            "imported: \(imported), skipped: \(skipped), withoutAudio: \(withoutAudio), orphanFolders: \(orphanFolders)"
        }
    }

    public static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Stenographer", isDirectory: true)
    }

    let db: StenoDatabase
    let root: URL

    public init(database: StenoDatabase, v1Root: URL = V1Importer.defaultRoot) {
        db = database
        root = v1Root.standardizedFileURL
    }

    struct Meeting {
        var id: UUID
        var title: String
        var createdAt: Date
        var starred: Bool
        var audio: URL?
        var humanNotes: String
        var finalDoc: String
        var enhanced: String
    }

    public func run() throws -> Report {
        let fm = FileManager.default
        var report = Report()
        let dbURL = root.appendingPathComponent("stenographer.db")
        let meetings = fm.fileExists(atPath: dbURL.path) ? try readMeetings(dbURL) : []

        var referencedAudio = Set<String>()
        for meeting in meetings {
            if let audio = meeting.audio { referencedAudio.insert(audio.standardizedFileURL.path) }
            if try exists(meeting.id) {
                report.skipped += 1
                continue
            }
            let dir = db.paths.sessionDirectory(id: meeting.id)
            if let audio = meeting.audio {
                let manifest = try importAudio(audio, into: dir, id: meeting.id, createdAt: meeting.createdAt)
                try insert(meeting, manifest: manifest, status: .captured)
                report.toProcess.append(meeting.id.uuidString)
            } else {
                let manifest = SessionManifest(
                    id: meeting.id, createdAt: meeting.createdAt, mode: .imported, t0HostTime: 0,
                    timebaseNumer: HostTime.timebase.numer, timebaseDenom: HostTime.timebase.denom,
                    state: .captured, endedAt: meeting.createdAt, parts: [])
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                try ManifestIO.write(manifest, to: ManifestIO.url(in: dir))
                try insert(meeting, manifest: manifest, status: .ready)
                report.withoutAudio += 1
            }
            report.imported += 1
        }

        let recordings = root.appendingPathComponent("recordings", isDirectory: true)
        let folders = ((try? fm.contentsOfDirectory(atPath: recordings.path)) ?? []).sorted()
        for name in folders {
            let wav = recordings.appendingPathComponent(name).appendingPathComponent("recording.wav")
            guard fm.fileExists(atPath: wav.path), !referencedAudio.contains(wav.standardizedFileURL.path) else { continue }
            let id = Self.orphanID(folder: name)
            if try exists(id) { continue }
            let createdAt = Self.folderDate(name)
                ?? ((try? fm.attributesOfItem(atPath: wav.path)[.creationDate]) as? Date) ?? Date()
            let manifest = try importAudio(wav, into: db.paths.sessionDirectory(id: id), id: id, createdAt: createdAt)
            let meeting = Meeting(
                id: id, title: "Imported recording \(name)", createdAt: createdAt, starred: false, audio: wav,
                humanNotes: "", finalDoc: "", enhanced: "")
            try insert(meeting, manifest: manifest, status: .captured)
            report.toProcess.append(id.uuidString)
            report.orphanFolders += 1
        }
        StenoLog.store.info("V1 import: \(report.summary, privacy: .public)")
        return report
    }

    // MARK: - v1 database

    /// Reads from a copy: v1's live file cannot be opened read-only while its WAL is active.
    func readMeetings(_ dbURL: URL) throws -> [Meeting] {
        let fm = FileManager.default
        let temp = fm.temporaryDirectory.appendingPathComponent("steno-v1-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: temp) }
        let copy = temp.appendingPathComponent("stenographer.db")
        try fm.copyItem(at: dbURL, to: copy)
        let wal = URL(fileURLWithPath: dbURL.path + "-wal")
        if fm.fileExists(atPath: wal.path) {
            try fm.copyItem(at: wal, to: URL(fileURLWithPath: copy.path + "-wal"))
        }

        let queue = try DatabaseQueue(path: copy.path)
        return try queue.read { db in
            var notes: [String: Row] = [:]
            if try db.tableExists("notes") {
                for row in try Row.fetchAll(db, sql: "SELECT * FROM notes") {
                    if let id: String = row["meeting_id"] { notes[id] = row }
                }
            }
            return try Row.fetchAll(db, sql: "SELECT * FROM meetings ORDER BY created_at").map { row in
                let v1ID: String = row["id"]
                let note = notes[v1ID]
                let rawCreated: Double = row["created_at"] ?? 0
                let title: String = row["title"] ?? ""
                return Meeting(
                    id: UUID(uuidString: v1ID) ?? Self.deterministicUUID("v1-meeting:\(v1ID)"),
                    title: title == "Untitled Meeting" ? "" : title,
                    createdAt: Date(timeIntervalSince1970: rawCreated > 1e11 ? rawCreated / 1000 : rawCreated),
                    starred: (row["starred"] as Int?) == 1,
                    audio: resolveAudio(audioPath: row["audio_path"], folderPath: row["folder_path"]),
                    humanNotes: note?["human_doc_text"] ?? "",
                    finalDoc: note?["final_doc_text"] ?? "",
                    enhanced: note?["enhanced_md"] ?? "")
            }
        }
    }

    /// Mirrors v1 `safeRecordingsPath`: returns the recording only if it exists.
    func resolveAudio(audioPath: String?, folderPath: String?) -> URL? {
        let fm = FileManager.default
        if let audioPath, !audioPath.isEmpty, audioPath.hasPrefix("/"), fm.fileExists(atPath: audioPath) {
            return URL(fileURLWithPath: audioPath)
        }
        guard let folder = folderPath, !folder.isEmpty else { return nil }
        let dir: URL
        if folder.hasPrefix("/") {
            dir = URL(fileURLWithPath: folder)
        } else if folder.hasPrefix("recordings/") || folder.hasPrefix("recordings\\") {
            dir = root.appendingPathComponent(folder)
        } else {
            dir = root.appendingPathComponent("recordings").appendingPathComponent(folder)
        }
        let wav = dir.appendingPathComponent("recording.wav")
        return fm.fileExists(atPath: wav.path) ? wav : nil
    }

    // MARK: - v2 writes

    func exists(_ id: UUID) throws -> Bool {
        try db.writer.read { try SessionRecord.exists($0, key: id.uuidString) }
    }

    func importAudio(_ src: URL, into dir: URL, id: UUID, createdAt: Date) throws -> SessionManifest {
        do {
            return try Importer.importAudio(from: src, into: dir, id: id, createdAt: createdAt)
        } catch {
            try? FileManager.default.removeItem(at: dir)
            throw error
        }
    }

    func insert(_ meeting: Meeting, manifest: SessionManifest, status: SessionStatus) throws {
        let id = meeting.id.uuidString
        let session = SessionRecord(
            id: id, title: meeting.title, createdAt: meeting.createdAt, endedAt: manifest.endedAt, mode: .imported,
            status: status, durationSec: manifest.durationSeconds, starred: meeting.starred, folder: id)
        try db.writer.write { db in
            try session.insert(db)
            if !meeting.humanNotes.isEmpty {
                try db.execute(
                    sql: "INSERT INTO note (session_id, body_md, updated_at) VALUES (?, ?, ?)",
                    arguments: [id, meeting.humanNotes, meeting.createdAt.timeIntervalSince1970])
            }
            let generated: (String, String)? =
                !meeting.finalDoc.isEmpty ? ("v1-final", meeting.finalDoc)
                : !meeting.enhanced.isEmpty ? ("v1-enhanced", meeting.enhanced) : nil
            if let (template, body) = generated {
                try GeneratedNoteRecord(
                    sessionId: id, templateId: template, provider: "v1", model: "v1", bodyMd: body,
                    createdAt: meeting.createdAt
                ).insert(db)
            }
            try SearchIndex.reindex(db, sessionID: id)
        }
    }

    // MARK: - Helpers

    static func orphanID(folder: String) -> UUID { deterministicUUID("v1-folder:\(folder)") }

    /// MD5 of `seed` with RFC 4122 version 4 and variant bits set.
    static func deterministicUUID(_ seed: String) -> UUID {
        var bytes = Array(Insecure.MD5.hash(data: Data(seed.utf8)))
        bytes[6] = (bytes[6] & 0x0F) | 0x40
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    static func folderDate(_ name: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss"
        return formatter.date(from: name)
    }
}
