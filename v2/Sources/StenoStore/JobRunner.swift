import Foundation
import GRDB
import StenoModel

/// Serial queue of `process` jobs persisted in the `job` table.
public actor JobRunner {
    public typealias Processor = @Sendable (_ sessionDir: URL, _ runID: UUID) async throws -> TranscriptDocument
    public static let maxAttempts = 3

    private let db: StenoDatabase
    private let processor: Processor
    private let retryDelay: @Sendable (_ attempts: Int) -> Duration
    private var paused = false
    private var loop: Task<Void, Never>?
    private var wakeup: CheckedContinuation<Void, Never>?
    private var notBefore: [Int64: ContinuousClock.Instant] = [:]
    public private(set) var runningSessionID: String?

    public init(
        database: StenoDatabase, processor: @escaping Processor,
        retryDelay: @escaping @Sendable (Int) -> Duration = { .seconds(10 * $0) }
    ) {
        db = database
        self.processor = processor
        self.retryDelay = retryDelay
    }

    /// Queues a process job; a no-op when the session already has a queued or running job.
    public func enqueueProcess(sessionID: String) throws {
        let now = Date()
        do {
            try db.writer.write { db in
                var job = JobRecord(
                    id: nil, sessionId: sessionID, kind: "process", state: .queued, attempts: 0, lastError: nil,
                    createdAt: now, updatedAt: now)
                try job.insert(db)
            }
        } catch let error as DatabaseError where error.extendedResultCode == .SQLITE_CONSTRAINT_UNIQUE {
            return
        }
        poke()
    }

    public func start() {
        guard loop == nil else { return }
        loop = Task { await run() }
    }

    public func stop() {
        loop?.cancel()
        loop = nil
        poke()
    }

    /// No new job starts until `resume()`; a running job continues.
    public func pause() { paused = true }

    public func resume() {
        paused = false
        poke()
    }

    private func poke() {
        wakeup?.resume()
        wakeup = nil
    }

    private func run() async {
        while !Task.isCancelled {
            if !paused, let job = nextRunnableJob() {
                await execute(job)
                continue
            }
            if let soonest = notBefore.values.min() {
                Task { [weak self] in
                    try? await Task.sleep(until: soonest, clock: .continuous)
                    await self?.poke()
                }
            }
            await withCheckedContinuation { wakeup = $0 }
        }
    }

    private func nextRunnableJob() -> JobRecord? {
        let now = ContinuousClock.now
        let queued = (try? db.writer.read { db in
            try JobRecord.filter(Column("state") == JobState.queued.rawValue).order(Column("created_at"), Column("id")).fetchAll(db)
        }) ?? []
        return queued.first { job in notBefore[job.id ?? 0].map { $0 <= now } ?? true }
    }

    private func execute(_ job: JobRecord) async {
        guard let jobID = job.id else { return }
        notBefore[jobID] = nil
        let sessionDir: URL
        do {
            sessionDir = try await db.writer.write { db -> URL in
                guard let session = try SessionRecord.fetchOne(db, key: job.sessionId) else {
                    throw StoreError.notFound("Session \(job.sessionId)")
                }
                if session.status != .processing {
                    try SessionRepository.transition(db, id: session.id, to: .processing, error: nil)
                }
                try db.execute(
                    sql: "UPDATE job SET state = 'running', updated_at = ? WHERE id = ?",
                    arguments: [Date().timeIntervalSince1970, jobID])
                return self.db.paths.sessionDirectory(folder: session.folder)
            }
        } catch {
            StenoLog.store.error("Job \(jobID) cannot start: \(error.localizedDescription, privacy: .public)")
            try? await db.writer.write { db in
                try db.execute(
                    sql: "UPDATE job SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
                    arguments: [error.localizedDescription, Date().timeIntervalSince1970, jobID])
            }
            return
        }

        runningSessionID = job.sessionId
        defer { runningSessionID = nil }
        do {
            let document = try await processor(sessionDir, UUID())
            try await db.writer.write { db in
                try RunRepository.save(db, document: document, sessionID: job.sessionId)
                try SessionRepository.transition(db, id: job.sessionId, to: .ready, error: document.diarizationError)
                try db.execute(
                    sql: "UPDATE job SET state = 'done', updated_at = ? WHERE id = ?",
                    arguments: [Date().timeIntervalSince1970, jobID])
                try SearchIndex.reindex(db, sessionID: job.sessionId)
            }
        } catch {
            let attempts = job.attempts + 1
            let message = error.localizedDescription
            StenoLog.store.error("Job \(jobID) attempt \(attempts) failed: \(message, privacy: .public)")
            do {
                try await db.writer.write { db in
                    if attempts < Self.maxAttempts {
                        try db.execute(
                            sql: "UPDATE job SET state = 'queued', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
                            arguments: [attempts, message, Date().timeIntervalSince1970, jobID])
                    } else {
                        try db.execute(
                            sql: "UPDATE job SET state = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
                            arguments: [attempts, message, Date().timeIntervalSince1970, jobID])
                        try SessionRepository.transition(db, id: job.sessionId, to: .failed, error: message)
                    }
                }
            } catch {
                StenoLog.store.error("Recording job failure failed: \(error.localizedDescription, privacy: .public)")
            }
            if attempts < Self.maxAttempts {
                notBefore[jobID] = .now + retryDelay(attempts)
            }
        }
    }
}
