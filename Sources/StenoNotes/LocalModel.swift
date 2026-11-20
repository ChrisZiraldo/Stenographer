import CryptoKit
import Foundation
import StenoStore

/// A GGUF chat model the built-in llama.cpp engine can download and run.
public struct LocalModel: Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let summary: String
    public let repo: String
    public let file: String
    public let sizeBytes: Int64
    /// SHA-256 of the file, from the Hugging Face LFS metadata.
    public let sha256: String

    public var downloadURL: URL { URL(string: "https://huggingface.co/\(repo)/resolve/main/\(file)")! }
}

public enum LocalModelCatalog {
    public static let all: [LocalModel] = [
        LocalModel(
            id: "qwen3-4b-instruct-2507", name: "Qwen3 4B Instruct", summary: "Best quality for its size; recommended.",
            repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF", file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
            sizeBytes: 2_497_281_120, sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"),
        LocalModel(
            id: "gemma-3-4b-it", name: "Gemma 3 4B", summary: "Similar size; a different writing style.",
            repo: "unsloth/gemma-3-4b-it-GGUF", file: "gemma-3-4b-it-Q4_K_M.gguf",
            sizeBytes: 2_489_894_016, sha256: "04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19"),
        LocalModel(
            id: "llama-3.2-3b-instruct", name: "Llama 3.2 3B", summary: "Smallest and fastest.",
            repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
            sizeBytes: 2_019_377_696, sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff"),
    ]

    public static var `default`: LocalModel { all[0] }

    public static func model(id: String) -> LocalModel? { all.first { $0.id == id } }
}

/// Prompt budget for the built-in engine. The context is fixed, so long transcripts take the map-reduce path.
public enum LocalLLM {
    public static let contextTokens = 16_384
    public static let maxNewTokens = 3_072
    static let charsPerToken = 3
    static let promptOverheadTokens = 512

    public static var maxPromptChars: Int {
        (contextTokens - maxNewTokens - promptOverheadTokens) * charsPerToken
    }
}

public enum LocalModelError: Error, LocalizedError, Equatable {
    case http(Int)
    case checksumMismatch

    public var errorDescription: String? {
        switch self {
        case .http(let status): "Download failed (HTTP \(status))"
        case .checksumMismatch: "The downloaded model failed its integrity check and was discarded"
        }
    }
}

public struct LocalModelStore: Sendable {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    public init(paths: AppPaths) { self.init(directory: paths.modelsDirectory) }

    public func url(for model: LocalModel) -> URL { directory.appendingPathComponent(model.file) }

    /// Downloads are verified before they get their final name, so a file of the right size is a complete one.
    public func isInstalled(_ model: LocalModel) -> Bool {
        let size = (try? FileManager.default.attributesOfItem(atPath: url(for: model).path)[.size]) as? Int64
        return size == model.sizeBytes
    }

    public func delete(_ model: LocalModel) throws {
        for url in [url(for: model), partialURL(for: model)] where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    /// Downloads, verifies the SHA-256, then moves the file into place. Cancelling the task stops the transfer.
    public func download(_ model: LocalModel, progress: @escaping @Sendable (Double) -> Void) async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let partial = partialURL(for: model)
        try? FileManager.default.removeItem(at: partial)
        try await ModelDownloader(destination: partial, expectedBytes: model.sizeBytes, progress: progress)
            .download(from: model.downloadURL)
        do {
            guard try Self.sha256(of: partial) == model.sha256 else { throw LocalModelError.checksumMismatch }
            _ = try FileManager.default.replaceItemAt(url(for: model), withItemAt: partial)
        } catch {
            try? FileManager.default.removeItem(at: partial)
            throw error
        }
    }

    func partialURL(for model: LocalModel) -> URL { url(for: model).appendingPathExtension("part") }

    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// One-shot file download with progress, built on a download task (fast path; byte-by-byte streaming is not).
final class ModelDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let destination: URL
    private let expectedBytes: Int64
    private let progress: @Sendable (Double) -> Void
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?

    init(destination: URL, expectedBytes: Int64, progress: @escaping @Sendable (Double) -> Void) {
        self.destination = destination
        self.expectedBytes = expectedBytes
        self.progress = progress
    }

    func download(from url: URL) async throws {
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let task = session.downloadTask(with: url)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                lock.withLock { continuation = cont }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    private func finish(_ result: Result<Void, Error>) {
        let cont = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            defer { continuation = nil }
            return continuation
        }
        cont?.resume(with: result)
    }

    func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
    ) {
        let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : expectedBytes
        progress(min(1, Double(totalBytesWritten) / Double(max(total, 1))))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        if let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, status != 200 {
            return finish(.failure(LocalModelError.http(status)))
        }
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            finish(.success(()))
        } catch {
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        finish(.failure((error as? URLError)?.code == .cancelled ? CancellationError() : error))
    }
}

public struct LocalLLMProvider: LLMProvider {
    public typealias Generator = @Sendable (_ modelPath: String, _ system: String, _ prompt: String) -> AsyncThrowingStream<String, Error>

    public let id = "local"
    public let model: String
    public let modelPath: String
    public let generator: Generator

    public init(model: String, modelPath: String, generator: @escaping Generator) {
        self.model = model
        self.modelPath = modelPath
        self.generator = generator
    }

    public var maxPromptChars: Int { LocalLLM.maxPromptChars }

    public func stream(system: String, prompt: String) -> AsyncThrowingStream<String, Error> {
        generator(modelPath, system, prompt)
    }
}
