import Foundation
import Testing

@testable import StenoLlama

@Suite struct UTF8AssemblerTests {
    @Test func holdsBackSplitMultibyteCharacter() {
        var a = UTF8Assembler()
        let bytes = Array("é".utf8)  // 2 bytes
        #expect(a.append([bytes[0]]) == "")
        #expect(a.append([bytes[1]]) == "é")
    }

    @Test func splitsFourByteEmojiAcrossThreePieces() {
        var a = UTF8Assembler()
        let bytes = Array("a😀".utf8)
        #expect(a.append(Array(bytes[0..<2])) == "a")
        #expect(a.append(Array(bytes[2..<4])) == "")
        #expect(a.append(Array(bytes[4...])) == "😀")
    }

    @Test func passesAsciiThroughImmediately() {
        var a = UTF8Assembler()
        #expect(a.append(Array("hello".utf8)) == "hello")
    }

    @Test func flushDecodesLeftoverLossily() {
        var a = UTF8Assembler()
        _ = a.append([0xE2, 0x82])
        #expect(a.flush() == "\u{FFFD}")
        #expect(a.flush() == "")
    }
}

@Suite struct LlamaEngineTests {
    /// Needs a real model: `STENO_LLM_MODEL=/path/model.gguf swift test`.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["STENO_LLM_MODEL"] != nil))
    func generatesText() async throws {
        let path = ProcessInfo.processInfo.environment["STENO_LLM_MODEL"]!
        var out = ""
        for try await delta in LlamaEngine.shared.generate(
            modelPath: path, system: "Answer in one word.", prompt: "What color is the sky on a clear day?",
            options: LlamaOptions(contextTokens: 2048, maxNewTokens: 16, temperature: 0))
        {
            out += delta
        }
        LlamaEngine.shared.unload()
        #expect(out.lowercased().contains("blue"))
    }

    @Test func missingModelThrows() async {
        await #expect(throws: LlamaError.self) {
            for try await _ in LlamaEngine.shared.generate(
                modelPath: "/nonexistent.gguf", system: "", prompt: "hi", options: LlamaOptions())
            {}
        }
    }
}
