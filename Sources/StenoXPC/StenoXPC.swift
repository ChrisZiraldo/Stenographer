import Foundation

public enum StenoXPC {
    public static let serviceName = "com.ziraldo.Stenographer.Worker"

    public static func workerInterface() -> NSXPCInterface {
        NSXPCInterface(with: StenoWorkerProtocol.self)
    }

    public static func clientInterface() -> NSXPCInterface {
        NSXPCInterface(with: StenoClientProtocol.self)
    }
}

/// App → worker. Replies carry `nil` on success or an error message.
@objc public protocol StenoWorkerProtocol {
    func prepareModels(reply: @escaping (String?) -> Void)
    /// Replies with `TranscriptDocument` JSON. `maxSpeakers` 0 = automatic.
    func process(sessionDir: String, runID: String, maxSpeakers: Int, reply: @escaping (Data?, String?) -> Void)
    func liveStart(mode: String, reply: @escaping (String?) -> Void)
    /// `samples` are Float32 little-endian, 16 kHz mono.
    func liveAppend(track: String, startSample: Int64, samples: Data)
    func liveStop(reply: @escaping () -> Void)
    /// Streams `llmDelta` callbacks for `requestID`, then replies `nil` or an error message.
    func llmGenerate(
        requestID: String, modelPath: String, system: String, prompt: String, contextTokens: Int, maxNewTokens: Int,
        reply: @escaping (String?) -> Void)
    func llmCancel(requestID: String)
}

/// Worker → app.
@objc public protocol StenoClientProtocol {
    /// `LiveSegment` JSON.
    func liveSegment(_ json: Data)
    func processProgress(stage: String, fraction: Double)
    func llmDelta(requestID: String, text: String)
}
