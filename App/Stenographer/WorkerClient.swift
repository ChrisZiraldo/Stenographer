import Foundation
import StenoAudio
import StenoModel
import StenoXPC

enum WorkerError: Error, LocalizedError {
    case crashed
    case remote(String)

    var errorDescription: String? {
        switch self {
        case .crashed: "Worker crashed"
        case .remote(let message): message
        }
    }
}

/// Receives worker → app callbacks.
final class ClientReceiver: NSObject, StenoClientProtocol, @unchecked Sendable {
    var onLiveSegment: (@Sendable (LiveSegment) -> Void)?
    var onProgress: (@Sendable (String, Double) -> Void)?

    func liveSegment(_ json: Data) {
        if let segment = try? StenoJSON.decoder().decode(LiveSegment.self, from: json) { onLiveSegment?(segment) }
    }

    func processProgress(stage: String, fraction: Double) { onProgress?(stage, fraction) }
}

/// Owns the XPC connection to StenoWorker and recreates it when the worker dies.
final class WorkerClient: @unchecked Sendable {
    static let liveBatchSamples = 8_000

    let receiver = ClientReceiver()
    /// Called after the worker died during live captions and live was restarted.
    var onLiveRestarted: (@Sendable () -> Void)?

    private let lock = NSLock()
    private var connection: NSXPCConnection?
    private var pendingProcess: [UUID: CheckedContinuation<TranscriptDocument, Error>] = [:]
    private var liveMode: CaptureMode?
    private var liveBatches: [TrackKind: (start: Int64, samples: [Float])] = [:]

    private func proxy(onError: @escaping @Sendable (Error) -> Void = { _ in }) -> StenoWorkerProtocol {
        lock.withLock {
            if connection == nil { connection = makeConnection() }
            return connection!.remoteObjectProxyWithErrorHandler(onError) as! StenoWorkerProtocol
        }
    }

    private func makeConnection() -> NSXPCConnection {
        let c = NSXPCConnection(serviceName: StenoXPC.serviceName)
        c.remoteObjectInterface = StenoXPC.workerInterface()
        c.exportedInterface = StenoXPC.clientInterface()
        c.exportedObject = receiver
        c.interruptionHandler = { [weak self] in self?.connectionLost() }
        c.invalidationHandler = { [weak self] in self?.connectionLost() }
        c.resume()
        return c
    }

    private func connectionLost() {
        let (failed, mode) = lock.withLock { () -> ([CheckedContinuation<TranscriptDocument, Error>], CaptureMode?) in
            connection?.invalidationHandler = nil
            connection?.interruptionHandler = nil
            connection?.invalidate()
            connection = nil
            let failed = Array(pendingProcess.values)
            pendingProcess.removeAll()
            liveBatches.removeAll()
            return (failed, liveMode)
        }
        StenoLog.app.error("Worker connection lost (\(failed.count) jobs in flight)")
        failed.forEach { $0.resume(throwing: WorkerError.crashed) }
        if let mode {
            Task {
                try? await self.startLive(mode: mode)
                self.onLiveRestarted?()
            }
        }
    }

    func prepareModels() async throws {
        let message: String? = try await withCheckedThrowingContinuation { cont in
            let once = OnceFlag()
            proxy(onError: { if once.take() { cont.resume(throwing: $0) } })
                .prepareModels { if once.take() { cont.resume(returning: $0) } }
        }
        if let message { throw WorkerError.remote(message) }
    }

    func process(sessionDir: URL, runID: UUID, maxSpeakers: Int) async throws -> TranscriptDocument {
        try await withCheckedThrowingContinuation { cont in
            let token = UUID()
            lock.withLock { pendingProcess[token] = cont }
            let take: @Sendable () -> CheckedContinuation<TranscriptDocument, Error>? = { [weak self] in
                self?.lock.withLock { self?.pendingProcess.removeValue(forKey: token) }
            }
            proxy(onError: { error in take()?.resume(throwing: error) })
                .process(sessionDir: sessionDir.path, runID: runID.uuidString, maxSpeakers: maxSpeakers) { data, message in
                    guard let cont = take() else { return }
                    if let data, let doc = try? StenoJSON.decoder().decode(TranscriptDocument.self, from: data) {
                        cont.resume(returning: doc)
                    } else {
                        cont.resume(throwing: WorkerError.remote(message ?? "Invalid worker reply"))
                    }
                }
        }
    }

    func startLive(mode: CaptureMode) async throws {
        lock.withLock {
            liveMode = mode
            liveBatches.removeAll()
        }
        let message: String? = try await withCheckedThrowingContinuation { cont in
            let once = OnceFlag()
            proxy(onError: { if once.take() { cont.resume(throwing: $0) } })
                .liveStart(mode: mode.rawValue) { if once.take() { cont.resume(returning: $0) } }
        }
        if let message { throw WorkerError.remote(message) }
    }

    /// Batches chunks per track to ≥ 0.5 s before sending.
    func appendLive(_ chunk: LiveChunk) {
        let ready: (Int64, [Float])? = lock.withLock {
            guard liveMode != nil else { return nil }
            var batch = liveBatches[chunk.track] ?? (chunk.startSample, [])
            var flushed: (Int64, [Float])?
            if batch.start + Int64(batch.samples.count) != chunk.startSample, !batch.samples.isEmpty {
                flushed = (batch.start, batch.samples)
                batch = (chunk.startSample, [])
            }
            if batch.samples.isEmpty { batch.start = chunk.startSample }
            batch.samples += chunk.samples
            if flushed == nil, batch.samples.count >= Self.liveBatchSamples {
                flushed = (batch.start, batch.samples)
                batch = (batch.start + Int64(batch.samples.count), [])
            }
            liveBatches[chunk.track] = batch
            return flushed
        }
        guard let (start, samples) = ready else { return }
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        proxy().liveAppend(track: chunk.track.rawValue, startSample: start, samples: data)
    }

    func stopLive() async {
        let rest = lock.withLock { () -> [(TrackKind, Int64, [Float])] in
            liveMode = nil
            defer { liveBatches.removeAll() }
            return liveBatches.compactMap { $0.value.samples.isEmpty ? nil : ($0.key, $0.value.start, $0.value.samples) }
        }
        let p = proxy()
        for (track, start, samples) in rest {
            p.liveAppend(track: track.rawValue, startSample: start, samples: samples.withUnsafeBufferPointer { Data(buffer: $0) })
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let once = OnceFlag()
            proxy(onError: { _ in if once.take() { cont.resume() } }).liveStop { if once.take() { cont.resume() } }
        }
    }
}

final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var used = false

    func take() -> Bool {
        lock.withLock {
            defer { used = true }
            return !used
        }
    }
}
