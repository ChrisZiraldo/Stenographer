import ArgumentParser
import Foundation
import StenoLlama
import StenoModel
import StenoNotes
import StenoStore

struct Notes: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Generate meeting notes from a processed session (scratch database; the app's data is untouched).")

    @Argument var dir: String
    @Option(help: "Template id: general, 1-1, standup, interview, planning, design-review, retrospective.") var template = "general"
    @Option(help: "OpenAI-compatible base URL.") var baseURL = "http://localhost:11434/v1"
    @Option(help: "Model name for the OpenAI-compatible server (not needed with --gguf).") var model = ""
    @Option(help: "Run a local GGUF file with the built-in llama.cpp engine instead of a server.") var gguf: String?
    @Option var maxPromptChars = 48_000

    func run() async throws {
        guard let template = NoteTemplate.all.first(where: { $0.id == template }) else {
            throw ValidationError("unknown template '\(template)'")
        }
        guard let base = URL(string: baseURL) else { throw ValidationError("bad --base-url") }
        let sessionDir = absoluteURL(dir)
        let manifest = try ManifestIO.read(from: ManifestIO.url(in: sessionDir))
        let runs = sessionDir.appendingPathComponent("runs")
        let newest = try FileManager.default.contentsOfDirectory(at: runs, includingPropertiesForKeys: [.contentModificationDateKey])
            .filter { FileManager.default.fileExists(atPath: $0.appendingPathComponent("transcript.json").path) }
            .max { (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                < (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
        guard let newest else { throw ValidationError("no processed run in \(runs.path); run `steno process` first") }
        let doc = try StenoJSON.read(TranscriptDocument.self, from: newest.appendingPathComponent("transcript.json"))

        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("steno-notes-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let db = try StenoDatabase(paths: AppPaths(root: scratch))
        let sessions = SessionRepository(db)
        let id = manifest.id.uuidString
        try sessions.create(manifest: manifest)
        try sessions.transition(id: id, to: .processing)
        try RunRepository(db).save(document: doc, sessionID: id)
        try sessions.transition(id: id, to: .ready)

        let provider: any LLMProvider
        if let gguf {
            let path = absoluteURL(gguf).path
            provider = LocalLLMProvider(model: URL(fileURLWithPath: path).lastPathComponent, modelPath: path) { path, system, prompt in
                LlamaEngine.shared.generate(
                    modelPath: path, system: system, prompt: prompt,
                    options: LlamaOptions(contextTokens: LocalLLM.contextTokens, maxNewTokens: LocalLLM.maxNewTokens))
            }
        } else {
            guard !model.isEmpty else { throw ValidationError("pass --model (server) or --gguf (built-in engine)") }
            provider = OpenAICompatibleProvider(baseURL: base, model: model, apiKey: nil, maxPromptChars: maxPromptChars)
        }
        for try await delta in NoteGenerator(database: db).generate(sessionID: id, template: template, provider: provider) {
            FileHandle.standardOutput.write(Data(delta.utf8))
        }
        LlamaEngine.shared.unload()
        print("\n\ntitle: \(try sessions.get(id: id)?.title ?? "")")
    }
}
