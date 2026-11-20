import Foundation
import LlamaSwift

public struct LlamaOptions: Sendable, Equatable {
    public var contextTokens: Int
    public var maxNewTokens: Int
    /// 0 selects greedy decoding.
    public var temperature: Float

    public init(contextTokens: Int = 16_384, maxNewTokens: Int = 3_072, temperature: Float = 0.3) {
        self.contextTokens = contextTokens
        self.maxNewTokens = maxNewTokens
        self.temperature = temperature
    }
}

public enum LlamaError: Error, LocalizedError, Equatable {
    case modelNotFound(String)
    case modelLoadFailed(String)
    case contextFailed
    case tokenizeFailed
    case promptTooLong(tokens: Int, limit: Int)
    case decodeFailed(Int32)

    public var errorDescription: String? {
        switch self {
        case .modelNotFound(let path): "Model file not found: \(path)"
        case .modelLoadFailed(let path): "Could not load the model at \(path). Is it a valid GGUF file?"
        case .contextFailed: "Could not allocate the model context (not enough memory?)"
        case .tokenizeFailed: "Could not tokenize the prompt"
        case .promptTooLong(let tokens, let limit): "Prompt is \(tokens) tokens; this model setup allows \(limit)"
        case .decodeFailed(let code): "Model evaluation failed (code \(code))"
        }
    }
}

/// Reassembles UTF-8 text from token byte pieces: a token can end mid-character, so incomplete trailing
/// sequences are held back until the rest arrives.
public struct UTF8Assembler: Sendable {
    private var pending: [UInt8] = []

    public init() {}

    public mutating func append(_ bytes: [UInt8]) -> String {
        pending += bytes
        let cut = Self.completePrefixLength(pending)
        guard cut > 0 else { return "" }
        let text = String(decoding: pending[..<cut], as: UTF8.self)
        pending.removeFirst(cut)
        return text
    }

    /// Whatever is left, decoded lossily.
    public mutating func flush() -> String {
        defer { pending.removeAll() }
        return String(decoding: pending, as: UTF8.self)
    }

    static func completePrefixLength(_ bytes: [UInt8]) -> Int {
        var i = bytes.count
        var looked = 0
        while i > 0, looked < 4 {
            i -= 1
            looked += 1
            let byte = bytes[i]
            if byte & 0xC0 == 0x80 { continue }  // continuation byte: keep looking for its lead
            let need = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : byte >= 0xC0 ? 2 : 1
            return bytes.count - i >= need ? bytes.count : i
        }
        return bytes.count
    }
}

final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    func set() { lock.withLock { value = true } }
    var isSet: Bool { lock.withLock { value } }
}

/// Runs GGUF chat models in-process through llama.cpp (Metal). Requests are serialized on one queue; the loaded
/// model stays resident between requests and is replaced when another model path is requested.
public final class LlamaEngine: @unchecked Sendable {
    public static let shared = LlamaEngine()

    private static let backendReady: Void = {
        llama_backend_init()
        llama_log_set({ _, _, _ in }, nil)
    }()

    private let queue = DispatchQueue(label: "com.ziraldo.Stenographer.llama", qos: .userInitiated)
    private var loadedPath: String?
    private var model: OpaquePointer?

    public init() {}

    /// Streams generated text. Cancelling the consumer aborts evaluation, including a long prompt pass.
    public func generate(
        modelPath: String, system: String, prompt: String, options: LlamaOptions = LlamaOptions()
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let cancel = CancelFlag()
            continuation.onTermination = { _ in cancel.set() }
            queue.async {
                do {
                    try self.run(
                        modelPath: modelPath, system: system, prompt: prompt, options: options, cancel: cancel
                    ) { continuation.yield($0) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    /// Frees the resident model.
    /// Blocks until the model is freed. Call before process exit: ggml asserts if Metal resources outlive its static teardown.
    public func unload() {
        queue.sync {
            if let model = self.model { llama_model_free(model) }
            self.model = nil
            self.loadedPath = nil
        }
    }

    private func loadModel(at path: String) throws -> OpaquePointer {
        if let model, loadedPath == path { return model }
        if let model { llama_model_free(model) }
        model = nil
        loadedPath = nil
        guard FileManager.default.fileExists(atPath: path) else { throw LlamaError.modelNotFound(path) }
        guard let loaded = llama_model_load_from_file(path, llama_model_default_params()) else {
            throw LlamaError.modelLoadFailed(path)
        }
        model = loaded
        loadedPath = path
        return loaded
    }

    private func run(
        modelPath: String, system: String, prompt: String, options: LlamaOptions, cancel: CancelFlag,
        emit: (String) -> Void
    ) throws {
        _ = Self.backendReady
        let model = try loadModel(at: modelPath)
        guard let vocab = llama_model_get_vocab(model) else { throw LlamaError.modelLoadFailed(modelPath) }

        let trained = Int(llama_model_n_ctx_train(model))
        let nCtx = max(512, trained > 0 ? min(options.contextTokens, trained) : options.contextTokens)
        var params = llama_context_default_params()
        params.n_ctx = UInt32(nCtx)
        params.n_batch = 2048
        params.n_ubatch = 512
        let threads = Int32(max(2, ProcessInfo.processInfo.activeProcessorCount / 2))
        params.n_threads = threads
        params.n_threads_batch = threads
        guard let ctx = llama_init_from_model(model, params) else { throw LlamaError.contextFailed }
        defer { llama_free(ctx) }
        llama_set_abort_callback(
            ctx, { data in Unmanaged<CancelFlag>.fromOpaque(data!).takeUnretainedValue().isSet },
            Unmanaged.passUnretained(cancel).toOpaque())

        var tokens = try Self.tokenize(Self.format(model: model, system: system, prompt: prompt), vocab: vocab)
        let reserve = 64
        guard tokens.count + reserve < nCtx else {
            throw LlamaError.promptTooLong(tokens: tokens.count, limit: nCtx - reserve)
        }
        let maxNew = min(options.maxNewTokens, nCtx - tokens.count)

        var offset = 0
        while offset < tokens.count {
            let count = min(Int(params.n_batch), tokens.count - offset)
            let status = tokens.withUnsafeMutableBufferPointer { buffer in
                llama_decode(ctx, llama_batch_get_one(buffer.baseAddress! + offset, Int32(count)))
            }
            if cancel.isSet { return }
            guard status == 0 else { throw LlamaError.decodeFailed(status) }
            offset += count
        }

        let sampler = llama_sampler_chain_init(llama_sampler_chain_default_params())!
        defer { llama_sampler_free(sampler) }
        if options.temperature > 0 {
            llama_sampler_chain_add(sampler, llama_sampler_init_top_k(40))
            llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.9, 1))
            llama_sampler_chain_add(sampler, llama_sampler_init_temp(options.temperature))
            llama_sampler_chain_add(sampler, llama_sampler_init_dist(UInt32.random(in: 0...UInt32.max)))
        } else {
            llama_sampler_chain_add(sampler, llama_sampler_init_greedy())
        }

        var assembler = UTF8Assembler()
        var piece = [CChar](repeating: 0, count: 256)
        for _ in 0..<maxNew {
            if cancel.isSet { return }
            var token = llama_sampler_sample(sampler, ctx, -1)
            if llama_vocab_is_eog(vocab, token) { break }
            var written = llama_token_to_piece(vocab, token, &piece, Int32(piece.count), 0, false)
            if written < 0 {
                piece = [CChar](repeating: 0, count: Int(-written))
                written = llama_token_to_piece(vocab, token, &piece, Int32(piece.count), 0, false)
            }
            if written > 0 {
                let text = assembler.append(piece[..<Int(written)].map { UInt8(bitPattern: $0) })
                if !text.isEmpty { emit(text) }
            }
            let status = withUnsafeMutablePointer(to: &token) { llama_decode(ctx, llama_batch_get_one($0, 1)) }
            if cancel.isSet { return }
            guard status == 0 else { throw LlamaError.decodeFailed(status) }
        }
        let rest = assembler.flush()
        if !rest.isEmpty { emit(rest) }
    }

    /// The model's own chat template; ChatML when it has none or llama.cpp cannot apply it.
    static func format(model: OpaquePointer, system: String, prompt: String) -> String {
        if let template = llama_model_chat_template(model, nil),
            let text = applyTemplate(template, system: system, prompt: prompt)
        {
            return text
        }
        return "<|im_start|>system\n\(system)<|im_end|>\n<|im_start|>user\n\(prompt)<|im_end|>\n<|im_start|>assistant\n"
    }

    private static func applyTemplate(_ template: UnsafePointer<CChar>, system: String, prompt: String) -> String? {
        system.withCString { sys in
            prompt.withCString { usr in
                "system".withCString { systemRole in
                    "user".withCString { userRole in
                        var messages = [
                            llama_chat_message(role: systemRole, content: sys),
                            llama_chat_message(role: userRole, content: usr),
                        ]
                        var capacity = (system.utf8.count + prompt.utf8.count) * 2 + 1024
                        var buffer = [CChar](repeating: 0, count: capacity)
                        var length = llama_chat_apply_template(template, &messages, messages.count, true, &buffer, Int32(capacity))
                        if Int(length) > capacity {
                            capacity = Int(length)
                            buffer = [CChar](repeating: 0, count: capacity)
                            length = llama_chat_apply_template(template, &messages, messages.count, true, &buffer, Int32(capacity))
                        }
                        guard length > 0 else { return nil }
                        return String(decoding: buffer[..<Int(length)].map { UInt8(bitPattern: $0) }, as: UTF8.self)
                    }
                }
            }
        }
    }

    private static func tokenize(_ text: String, vocab: OpaquePointer) throws -> [llama_token] {
        let length = Int32(text.utf8.count)
        var tokens = [llama_token](repeating: 0, count: Int(length) + 16)
        var count = llama_tokenize(vocab, text, length, &tokens, Int32(tokens.count), false, true)
        if count < 0 {
            tokens = [llama_token](repeating: 0, count: Int(-count))
            count = llama_tokenize(vocab, text, length, &tokens, Int32(tokens.count), false, true)
        }
        guard count > 0 else { throw LlamaError.tokenizeFailed }
        return Array(tokens.prefix(Int(count)))
    }
}
