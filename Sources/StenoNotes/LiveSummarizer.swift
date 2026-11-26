import Foundation
import StenoModel

/// Builds the prompt for "what are people talking about right now" from live captions.
public enum LiveSummaryPrompt {
    public static let system = """
        You help someone whose mind wandered during a live meeting get back on track at a glance: what is being \
        discussed right now and what was just said.
        You get the most recent live captions, formatted as "[mm:ss] Speaker: text". Captions are machine-generated and \
        speaker labels are provisional ("Me" is the user, "Others" are remote participants), so tolerate errors.

        Reply in exactly this format, plain text, no preamble:
        Topic now: <one short sentence on what is being discussed right now>
        Just said:
        - <2 to 4 short bullets, most recent last, naming who said what when it is clear>
        Open question: <only if a question in the captions is still unanswered: quote it briefly with who asked it. \
        If there is none, leave this line out entirely>

        Rules:
        - "Topic now" is the headline: plain words, specific (names, features, decisions), under 20 words.
        - Use only speaker names that appear in the captions, exactly as written. Never attribute a line to a different speaker.
        - Do not invent questions or facts. Do not guess who a question was meant for.
        - The last few lines matter most. "Topic now" must describe the final lines, not earlier ones; older lines are only context.
        """

    /// Captions from the last `window` seconds (relative to the newest segment), with echoed mic lines dropped,
    /// formatted one per line, keeping the newest lines that fit in `maxChars`.
    public static func lines(segments: [LiveSegment], window: Double = 120, maxChars: Int) -> [String] {
        guard let newest = segments.map(\.end).max() else { return [] }
        let recent = dropEcho(segments.filter { $0.end >= newest - window && !$0.text.isEmpty })
            .sorted { $0.start < $1.start }
        var kept: [String] = []
        var size = 0
        for segment in recent.reversed() {
            let line = "[\(TranscriptFormatter.timestamp(segment.start))] \(segment.speakerLabel): \(segment.text)"
            let added = line.count + (kept.isEmpty ? 0 : 1)
            if !kept.isEmpty, size + added > maxChars { break }
            size += added
            kept.append(line)
        }
        return kept.reversed()
    }

    /// Drops mic segments whose words are mostly repeated by a non-mic segment at about the same time (speaker bleed).
    static func dropEcho(_ segments: [LiveSegment]) -> [LiveSegment] {
        let others = segments.filter { $0.track != .mic }
        return segments.filter { segment in
            guard segment.track == .mic else { return true }
            let mine = tokens(segment.text)
            guard !mine.isEmpty else { return true }
            var theirs: [String: Int] = [:]
            for other in others where other.start <= segment.end + 2 && other.end >= segment.start - 2 {
                for token in tokens(other.text) { theirs[token, default: 0] += 1 }
            }
            var shared = 0
            for token in mine where theirs[token, default: 0] > 0 {
                theirs[token]! -= 1
                shared += 1
            }
            return Double(shared) / Double(mine.count) < 0.6
        }
    }

    private static func tokens(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }
}

public enum LiveSummarizer {
    static let systemReserve = 1500

    /// Returns nil when there is nothing to summarize yet.
    public static func summarize(segments: [LiveSegment], provider: any LLMProvider, window: Double = 120) async throws -> String? {
        let budget = max(500, provider.maxPromptChars - LiveSummaryPrompt.system.count - systemReserve)
        let lines = LiveSummaryPrompt.lines(segments: segments, window: window, maxChars: budget)
        guard !lines.isEmpty else { return nil }
        let text = try await provider.complete(system: LiveSummaryPrompt.system, prompt: lines.joined(separator: "\n"))
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// The model's reply split into the parts the "Right now" tab shows.
public struct LiveSummary: Equatable, Sendable {
    public var topic: String
    public var bullets: [String]
    public var openQuestion: String?

    public static func parse(_ text: String) -> LiveSummary {
        var topic = ""
        var bullets: [String] = []
        var question: String?
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if let value = value(of: "Topic now:", in: line) {
                topic = value
            } else if let value = value(of: "Open question:", in: line) {
                if !isNone(value) { question = value }
            } else if line.hasPrefix("-") || line.hasPrefix("•") || line.hasPrefix("*") {
                let bullet = line.dropFirst().trimmingCharacters(in: .whitespaces)
                if !bullet.isEmpty { bullets.append(bullet) }
            }
        }
        // Unrecognized reply: show it whole rather than nothing.
        if topic.isEmpty, bullets.isEmpty { topic = text.trimmingCharacters(in: .whitespacesAndNewlines) }
        return LiveSummary(topic: topic, bullets: bullets, openQuestion: question)
    }

    /// Models answer "no open question" many ways: Nothing, None, N/A, "No open questions", "-".
    static func isNone(_ value: String) -> Bool {
        let v = value.lowercased().trimmingCharacters(in: .punctuationCharacters.union(.whitespaces))
        return v.isEmpty || ["nothing", "none", "n/a", "na", "no", "null", "nil"].contains(v) || v.hasPrefix("no open")
            || v.hasPrefix("none ") || v.hasPrefix("nothing ") || v.hasPrefix("no question")
    }

    private static func value(of label: String, in line: String) -> String? {
        guard line.lowercased().hasPrefix(label.lowercased()) else { return nil }
        return String(line.dropFirst(label.count)).trimmingCharacters(in: .whitespaces)
    }
}
