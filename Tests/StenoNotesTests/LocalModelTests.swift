import CryptoKit
import Foundation
import Testing

@testable import StenoNotes

@Suite struct LocalModelTests {
    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("steno-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test func catalogIsWellFormed() {
        #expect(Set(LocalModelCatalog.all.map(\.id)).count == LocalModelCatalog.all.count)
        for model in LocalModelCatalog.all {
            #expect(model.sha256.count == 64)
            #expect(model.downloadURL.absoluteString == "https://huggingface.co/\(model.repo)/resolve/main/\(model.file)")
        }
        #expect(LocalModelCatalog.model(id: LocalModelCatalog.default.id) != nil)
    }

    @Test func sha256MatchesKnownDigest() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("f")
        let payload = Data("hello".utf8)
        try payload.write(to: file)
        #expect(try LocalModelStore.sha256(of: file) == SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined())
    }

    @Test func installedRequiresExactSize() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = LocalModelStore(directory: dir)
        let model = LocalModelCatalog.default
        #expect(!store.isInstalled(model))
        try Data(count: 10).write(to: store.url(for: model))
        #expect(!store.isInstalled(model))
        try store.delete(model)
        #expect(!FileManager.default.fileExists(atPath: store.url(for: model).path))
    }

    @Test func providerRequiresDownloadedModel() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let defaults = UserDefaults(suiteName: "steno-test-\(UUID().uuidString)")!
        defaults.set("local", forKey: LLMSettings.providerKey)
        let generator: LocalLLMProvider.Generator = { _, _, _ in AsyncThrowingStream { $0.finish() } }
        #expect(throws: LLMError.self) { try LLMSettings.makeProvider(defaults, modelsDirectory: dir, localGenerator: generator) }

        let gguf = dir.appendingPathComponent("mine.gguf")
        try Data(count: 4).write(to: gguf)
        defaults.set(LLMSettings.customModelID, forKey: LLMSettings.localModelKey)
        defaults.set(gguf.path, forKey: LLMSettings.localCustomPathKey)
        let provider = try LLMSettings.makeProvider(defaults, modelsDirectory: dir, localGenerator: generator)
        #expect(provider.id == "local")
        #expect(provider.maxPromptChars == LocalLLM.maxPromptChars)
    }
}
