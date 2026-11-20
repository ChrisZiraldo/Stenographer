import Foundation
import GRDB
import StenoAudio
import StenoModel

/// Launch-time reconciliation of the DB index with session folders, so no session stays stuck.
public struct RecoveryService: Sendable {
    let db: StenoDatabase
    let jobs: JobRunner

    public init(database: StenoDatabase, jobs: JobRunner) {
        db = database
        self.jobs = jobs
    }

    public struct Report: Sendable, Equatable {
        public var repaired = 0
        public var requeued = 0
        public var adopted = 0
        public var missing = 0
    }

    @discardableResult
    public func run() async throws -> Report {
        var report = Report()
        let sessions = SessionRepository(db)
        let fm = FileManager.default

        // Jobs interrupted mid-run go back to the queue.
        try await db.writer.write { db in
            try db.execute(sql: "UPDATE job SET state = 'queued' WHERE state = 'running'")
        }

        var known = Set<String>()
        for session in try sessions.all() {
            known.insert(session.folder)
            let dir = db.paths.sessionDirectory(folder: session.folder)
            guard fm.fileExists(atPath: ManifestIO.url(in: dir).path) else {
                if session.status != .failed || session.lastError != Self.folderMissing {
                    try await db.writer.write { db in
                        try db.execute(
                            sql: "UPDATE session SET status = 'failed', last_error = ? WHERE id = ?",
                            arguments: [Self.folderMissing, session.id])
                    }
                    report.missing += 1
                }
                continue
            }
            if session.status == .recording {
                let manifest = try Recovery.repairSession(at: dir)
                try sessions.markCaptured(id: session.id, manifest: manifest)
                try await jobs.enqueueProcess(sessionID: session.id)
                report.repaired += 1
            } else if session.status == .captured || session.status == .processing {
                if try !hasActiveJob(session.id) {
                    try await jobs.enqueueProcess(sessionID: session.id)
                    report.requeued += 1
                }
            }
        }

        // Folders with a manifest but no row (e.g. crash between folder creation and DB insert).
        let folders = (try? fm.contentsOfDirectory(atPath: db.paths.sessionsDirectory.path)) ?? []
        for folder in folders where !known.contains(folder) {
            let dir = db.paths.sessionDirectory(folder: folder)
            guard fm.fileExists(atPath: ManifestIO.url(in: dir).path), UUID(uuidString: folder) != nil else { continue }
            var manifest = try ManifestIO.read(from: ManifestIO.url(in: dir))
            guard manifest.id.uuidString == folder else { continue }
            if manifest.state == .recording { manifest = try Recovery.repairSession(at: dir) }
            try sessions.create(manifest: manifest)
            try await jobs.enqueueProcess(sessionID: manifest.id.uuidString)
            report.adopted += 1
        }
        StenoLog.store.info(
            "Recovery: repaired \(report.repaired), requeued \(report.requeued), adopted \(report.adopted), missing \(report.missing)"
        )
        return report
    }

    static let folderMissing = "Session folder missing"

    private func hasActiveJob(_ sessionID: String) throws -> Bool {
        try db.writer.read { db in
            try Int.fetchOne(
                db, sql: "SELECT COUNT(*) FROM job WHERE session_id = ? AND state IN ('queued','running')",
                arguments: [sessionID]) ?? 0 > 0
        }
    }
}
