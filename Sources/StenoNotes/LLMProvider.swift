import Foundation
import FoundationModels
import Security
import StenoStore

public protocol LLMProvider: Sendable {
    var id: String { get }
    var model: String { get }
    var maxPromptChars: Int { get }
    /// Yields text deltas.
    func stream(system: String, prompt: String) -> AsyncThrowingStream<String, Error>
}

extension LLMProvider {
    public func complete(system: String, prompt: String) async throws -> String {
        var text = ""
        for try await delta in stream(system: system, prompt: prompt) { text += delta }
        return text
    }
}

public enum LLMError: Error, LocalizedError {
    case unavailable(String)
    case http(Int, String)
    case notConfigured(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable(let why): "Apple Intelligence unavailable: \(why)"
        case .http(let status, let body): "LLM request failed (HTTP \(status)): \(body)"
        case .notConfigured(let what): what
        }
    }
}

public struct AppleOnDeviceProvider: LLMProvider {
    public let id = "apple"
    public let model = "system"

    public init() {}

    public static var isAvailable: Bool { SystemLanguageModel.default.availability == .available }

    public var maxPromptChars: Int { max(0, (SystemLanguageModel.default.contextSize - 1200) * 3) }

    public func stream(system: String, prompt: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                guard case .available = SystemLanguageModel.default.availability else {
                    continuation.finish(throwing: LLMError.unavailable("\(SystemLanguageModel.default.availability)"))
                    return
                }
                do {
                    let session = LanguageModelSession(instructions: system)
                    var emitted = ""
                    // Snapshots are cumulative; yield only the new suffix.
                    for try await snapshot in session.streamResponse(to: prompt) {
                        let full = snapshot.content
                        if full.hasPrefix(emitted) {
                            let delta = String(full.dropFirst(emitted.count))
                            if !delta.isEmpty { continuation.yield(delta) }
                        } else {
                            continuation.yield(full)
                        }
                        emitted = full
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

public struct OpenAICompatibleProvider: LLMProvider {
    public let id = "openai-compatible"
    public let model: String
    public let baseURL: URL
    public let apiKey: String?
    public let maxPromptChars: Int

    public init(baseURL: URL, model: String, apiKey: String?, maxPromptChars: Int) {
        self.baseURL = baseURL
        self.model = model
        self.apiKey = apiKey
        self.maxPromptChars = maxPromptChars
    }

    func request(system: String, prompt: String) throws -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent("chat/completions"), timeoutInterval: 600)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let apiKey, !apiKey.isEmpty { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        let body: [String: Any] = [
            "model": model, "stream": true,
            "messages": [["role": "system", "content": system], ["role": "user", "content": prompt]],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    public func stream(system: String, prompt: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard !model.isEmpty else { throw LLMError.notConfigured("Set a model name in Settings → AI") }
                    let (bytes, response) = try await URLSession.shared.bytes(for: request(system: system, prompt: prompt))
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard (200..<300).contains(status) else {
                        var body = Data()
                        for try await byte in bytes {
                            body.append(byte)
                            if body.count >= 500 { break }
                        }
                        throw LLMError.http(status, String(decoding: body, as: UTF8.self))
                    }
                    var parser = SSEParser()
                    for try await line in bytes.lines {
                        switch parser.consume(line) {
                        case .delta(let text): continuation.yield(text)
                        case .done: return continuation.finish()
                        case .none: break
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// OpenAI-style server-sent events: `data: {json}` lines, terminated by `data: [DONE]`.
public struct SSEParser {
    public enum Output: Equatable { case delta(String), done, none }

    public init() {}

    public mutating func consume(_ line: String) -> Output {
        guard line.hasPrefix("data:") else { return .none }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return .done }
        guard let data = payload.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let choices = json["choices"] as? [[String: Any]],
            let delta = choices.first?["delta"] as? [String: Any],
            let content = delta["content"] as? String, !content.isEmpty
        else { return .none }
        return .delta(content)
    }
}

public enum LLMSettings {
    public static let providerKey = "llm.provider"
    public static let baseURLKey = "llm.baseURL"
    public static let modelKey = "llm.model"
    public static let maxPromptCharsKey = "llm.maxPromptChars"
    public static let localModelKey = "llm.local.model"
    public static let localCustomPathKey = "llm.local.customPath"
    public static let customModelID = "custom"
    public static let defaultBaseURL = "http://localhost:11434/v1"
    public static let defaultMaxPromptChars = 48_000
    /// Seconds between "Right now" summaries while recording; 0 means only when Refresh is pressed.
    public static let liveSummaryIntervalKey = "llm.liveSummaryInterval"
    public static let defaultLiveSummaryInterval = 30

    public static func registerDefaults(_ defaults: UserDefaults = .standard) {
        defaults.register(defaults: [
            liveSummaryIntervalKey: defaultLiveSummaryInterval,
            providerKey: AppleOnDeviceProvider.isAvailable ? "apple" : "local",
            localModelKey: LocalModelCatalog.default.id, localCustomPathKey: "",
            baseURLKey: defaultBaseURL, modelKey: "", maxPromptCharsKey: defaultMaxPromptChars,
        ])
    }

    /// `localGenerator` runs the built-in model; the app passes the XPC worker, the CLI passes the engine directly.
    public static func makeProvider(
        _ defaults: UserDefaults = .standard, modelsDirectory: URL? = nil,
        localGenerator: LocalLLMProvider.Generator? = nil
    ) throws -> any LLMProvider {
        switch defaults.string(forKey: providerKey) {
        case "apple": return AppleOnDeviceProvider()
        case "local":
            guard let localGenerator else { throw LLMError.notConfigured("The built-in model is not available here") }
            let (name, path) = try localModel(defaults, modelsDirectory: modelsDirectory ?? AppPaths.defaultRoot.appendingPathComponent("Models"))
            return LocalLLMProvider(model: name, modelPath: path, generator: localGenerator)
        default: break
        }
        guard let url = URL(string: defaults.string(forKey: baseURLKey) ?? defaultBaseURL) else {
            throw LLMError.notConfigured("Invalid base URL in Settings → AI")
        }
        let maxChars = defaults.integer(forKey: maxPromptCharsKey)
        return OpenAICompatibleProvider(
            baseURL: url, model: defaults.string(forKey: modelKey) ?? "", apiKey: Keychain.apiKey(),
            maxPromptChars: maxChars > 0 ? maxChars : defaultMaxPromptChars)
    }
}

extension LLMSettings {
    /// Display name and file path of the selected built-in model; throws when it is not installed.
    static func localModel(_ defaults: UserDefaults, modelsDirectory: URL) throws -> (name: String, path: String) {
        let id = defaults.string(forKey: localModelKey) ?? LocalModelCatalog.default.id
        if id == customModelID {
            let path = defaults.string(forKey: localCustomPathKey) ?? ""
            guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else {
                throw LLMError.notConfigured("Choose a GGUF model file in Settings → AI")
            }
            return (URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent, path)
        }
        let model = LocalModelCatalog.model(id: id) ?? LocalModelCatalog.default
        let store = LocalModelStore(directory: modelsDirectory)
        guard store.isInstalled(model) else {
            throw LLMError.notConfigured("Download \(model.name) in Settings → AI first")
        }
        return (model.name, store.url(for: model).path)
    }
}

public enum Keychain {
    static let service = "com.ziraldo.Stenographer.llm"
    static let account = "default"

    public static func apiKey() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// Empty removes the key.
    public static func setAPIKey(_ key: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard !key.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(key.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}
