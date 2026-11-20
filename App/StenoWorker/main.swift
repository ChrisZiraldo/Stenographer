import Foundation
import StenoLlama
import StenoModel
import StenoPipeline
import StenoXPC

/// Carries XPC reply blocks (not Sendable by declaration; NSXPC allows calling them from any thread).
struct Reply<T>: @unchecked Sendable {
    let call: T
}

final class WorkerService: NSObject, StenoWorkerProtocol, @unchecked Sendable {
    private let transcriber = Transcriber()
    private let diarizer = Diarizer()
    private lazy var processor = SessionProcessor(transcriber: transcriber, diarizer: diarizer)
    private weak var connection: NSXPCConnection?
    private let lock = NSLock()
    private var liveInput: AsyncStream<LiveChunk>.Continuation?
    private var liveTask: Task<Void, Never>?
    private var llmTasks: [String: Task<Void, Never>] = [:]

    init(connection: NSXPCConnection) {
        self.connection = connection
    }

    private var client: StenoClientProtocol? {
        connection?.remoteObjectProxyWithErrorHandler { error in
            StenoLog.pipeline.error("Client proxy error: \(error.localizedDescription, privacy: .public)")
        } as? StenoClientProtocol
    }

    func prepareModels(reply: @escaping (String?) -> Void) {
        let reply = Reply(call: reply)
        Task {
            do {
                try await transcriber.prepare()
                try await diarizer.prepare()
                reply.call(nil)
            } catch {
                reply.call(error.localizedDescription)
            }
        }
    }

    func process(sessionDir: String, runID: String, maxSpeakers: Int, reply: @escaping (Data?, String?) -> Void) {
        let reply = Reply(call: reply)
        guard let run = UUID(uuidString: runID) else { return reply.call(nil, "Invalid run id") }
        let client = Reply(call: client)
        Task {
            do {
                let doc = try await processor.process(
                    sessionDir: URL(fileURLWithPath: sessionDir), runID: run, maxSpeakers: maxSpeakers > 0 ? maxSpeakers : nil
                ) { stage, fraction in client.call?.processProgress(stage: stage.rawValue, fraction: fraction) }
                reply.call(try StenoJSON.encoder().encode(doc), nil)
            } catch {
                reply.call(nil, error.localizedDescription)
            }
        }
    }

    func liveStart(mode: String, voices: Data, reply: @escaping (String?) -> Void) {
        let reply = Reply(call: reply)
        guard let mode = CaptureMode(rawValue: mode) else { return reply.call("Invalid mode \(mode)") }
        stopLive()
        let known = (try? StenoJSON.decoder().decode([KnownVoice].self, from: voices)) ?? []
        let live = LiveTranscriber(transcriber: transcriber, mode: mode, diarizer: diarizer, knownVoices: known)
        let (input, continuation) = AsyncStream.makeStream(of: LiveChunk.self, bufferingPolicy: .bufferingNewest(200))
        let client = Reply(call: client)
        let task = Task {
            do {
                try await live.prepare()
                reply.call(nil)
            } catch {
                reply.call(error.localizedDescription)
                return
            }
            let printer = Task {
                let encoder = StenoJSON.encoder()
                for await segment in live.segments {
                    if let data = try? encoder.encode(segment) { client.call?.liveSegment(data) }
                }
            }
            for await chunk in input { await live.append(chunk) }
            await live.finish()
            await printer.value
        }
        lock.withLock {
            liveInput = continuation
            liveTask = task
        }
    }

    func liveAppend(track: String, startSample: Int64, samples: Data) {
        guard let track = TrackKind(rawValue: track) else { return }
        let floats = samples.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        _ = lock.withLock { liveInput?.yield(LiveChunk(track: track, startSample: startSample, samples: floats)) }
    }

    func liveStop(reply: @escaping () -> Void) {
        let reply = Reply(call: reply)
        let task = stopLive()
        Task {
            await task?.value
            reply.call()
        }
    }

    func llmGenerate(
        requestID: String, modelPath: String, system: String, prompt: String, contextTokens: Int, maxNewTokens: Int,
        reply: @escaping (String?) -> Void
    ) {
        let reply = Reply(call: reply)
        let client = Reply(call: client)
        let options = LlamaOptions(contextTokens: contextTokens, maxNewTokens: maxNewTokens)
        let task = Task {
            var failure: String?
            do {
                for try await delta in LlamaEngine.shared.generate(modelPath: modelPath, system: system, prompt: prompt, options: options) {
                    client.call?.llmDelta(requestID: requestID, text: delta)
                }
            } catch {
                failure = error.localizedDescription
            }
            _ = lock.withLock { llmTasks.removeValue(forKey: requestID) }
            reply.call(failure)
        }
        lock.withLock { llmTasks[requestID] = task }
    }

    func llmCancel(requestID: String) {
        lock.withLock { llmTasks[requestID] }?.cancel()
    }

    @discardableResult
    private func stopLive() -> Task<Void, Never>? {
        lock.withLock {
            liveInput?.finish()
            liveInput = nil
            defer { liveTask = nil }
            return liveTask
        }
    }
}

final class ListenerDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.exportedInterface = StenoXPC.workerInterface()
        connection.exportedObject = WorkerService(connection: connection)
        connection.remoteObjectInterface = StenoXPC.clientInterface()
        connection.resume()
        return true
    }
}

let delegate = ListenerDelegate()
let listener = NSXPCListener.service()
listener.delegate = delegate
listener.resume()
