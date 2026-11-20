import Foundation
import StenoModel
import StenoStore

public enum NoteGeneratorError: Error, LocalizedError {
    case transcriptNotReady

    public var errorDescription: String? { "Transcript not ready" }
}

public enum TranscriptFormatter {
    public static func timestamp(_ seconds: Double) -> String {
        let s = Int(seconds)
        return String(format: "%02d:%02d", s / 60, s % 60)
    }

    public static func lines(_ transcript: [TranscriptLine]) -> [String] {
        transcript.map { "[\(timestamp($0.start))] \($0.speaker.name): \($0.text)" }
    }
}

public enum PromptChunker {
    /// Greedy split into chunks of at most `limit` characters (joined with newlines); never splits a line.
    /// A single line longer than `limit` becomes its own chunk.
    public static func chunks(_ lines: [String], limit: Int) -> [String] {
        var result: [String] = []
        var current: [String] = []
        var size = 0
        for line in lines {
            let added = line.count + (current.isEmpty ? 0 : 1)
            if !current.isEmpty, size + added > limit {
                result.append(current.joined(separator: "\n"))
                current = []
                size = 0
            }
            size += line.count + (current.isEmpty ? 0 : 1)
            current.append(line)
        }
        if !current.isEmpty { result.append(current.joined(separator: "\n")) }
        return result
    }
}

public struct NoteGenerator: Sendable {
    static let chunkOverhead = 2500
    static let maxTitleLength = 120

    let database: StenoDatabase

    public init(database: StenoDatabase) { self.database = database }

    /// Streams the generated Markdown. On successful completion the note is saved and an empty session
    /// title is filled. Cancelling the consumer saves nothing.
    public func generate(sessionID: String, template: NoteTemplate, provider: any LLMProvider) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let session = try SessionRepository(database).get(id: sessionID), session.status == .ready,
                        let runID = session.currentRunId
                    else { throw NoteGeneratorError.transcriptNotReady }
                    let notes = try NoteRepository(database).body(sessionID: sessionID)
                    let lines = TranscriptFormatter.lines(try RunRepository(database).utterances(runID: runID))
                    let transcript = lines.joined(separator: "\n")
                    let system = NotePrompts.mergeSystem(template: template)

                    var user = NotePrompts.mergeUser(humanNotes: notes, transcript: transcript)
                    if system.count + user.count > provider.maxPromptChars {
                        var summaries: [String] = []
                        for chunk in PromptChunker.chunks(lines, limit: max(1, provider.maxPromptChars - Self.chunkOverhead)) {
                            try Task.checkCancellation()
                            summaries.append(try await provider.complete(system: NotePrompts.chunkSystem, prompt: chunk))
                        }
                        user = NotePrompts.mergeUser(
                            humanNotes: notes, transcript: summaries.joined(separator: "\n\n---\n\n"),
                            transcriptHeading: "TRANSCRIPT SUMMARIES (chronological):")
                    }

                    var body = ""
                    for try await delta in provider.stream(system: system, prompt: user) {
                        try Task.checkCancellation()
                        body += delta
                        continuation.yield(delta)
                    }
                    try Task.checkCancellation()
                    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        try NoteRepository(database).insertGenerated(
                            GeneratedNoteRecord(
                                sessionId: sessionID, templateId: template.id, provider: provider.id, model: provider.model,
                                bodyMd: trimmed))
                        if session.title.isEmpty {
                            let raw = try await provider.complete(
                                system: "You write concise meeting titles.", prompt: NotePrompts.title(transcript: transcript, notes: notes))
                            let title = Self.cleanTitle(raw)
                            if !title.isEmpty { try SessionRepository(database).setTitle(id: sessionID, title: title) }
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

    static func cleanTitle(_ raw: String) -> String {
        var title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let quotes: Set<Character> = ["\"", "'", "“", "”", "‘", "’", "`"]
        while let first = title.first, quotes.contains(first) { title.removeFirst() }
        while let last = title.last, quotes.contains(last) { title.removeLast() }
        title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(title.prefix(maxTitleLength))
    }
}

public enum MarkdownExporter {
    public static func fileName(session: SessionRecord) -> String {
        let day = session.createdAt.formatted(.iso8601.year().month().day())
        let title = session.title.isEmpty ? "Untitled" : session.title
        return "\(day) \(title.replacingOccurrences(of: "/", with: "-")).md"
    }

    public static func export(session: SessionRecord, database: StenoDatabase) throws -> String {
        let notes = try NoteRepository(database).body(sessionID: session.id).trimmingCharacters(in: .whitespacesAndNewlines)
        let generated = try NoteRepository(database).generated(sessionID: session.id).first?.bodyMd ?? ""
        let lines = try session.currentRunId.map { try RunRepository(database).utterances(runID: $0) } ?? []

        let seconds = Int(session.durationSec.rounded())
        let duration = String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
        var out = "# \(session.title.isEmpty ? "Untitled" : session.title)\n"
        out += "_\(session.createdAt.formatted(date: .long, time: .shortened)) · \(duration)_\n"
        if !notes.isEmpty { out += "\n## Notes\n\(notes)\n" }
        if !generated.isEmpty { out += "\n## Generated Notes\n\(generated)\n" }
        if !lines.isEmpty {
            out += "\n## Transcript\n"
            for line in lines {
                out += "**[\(TranscriptFormatter.timestamp(line.start))] \(line.speaker.name):** \(line.text)\n\n"
            }
        }
        return out
    }
}
