import Foundation

public struct NoteTemplate: Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String

    public static let all: [NoteTemplate] = [
        NoteTemplate(id: "general", name: "General"),
        NoteTemplate(id: "1-1", name: "1:1 Meeting"),
        NoteTemplate(id: "standup", name: "Daily Standup"),
        NoteTemplate(id: "interview", name: "Interview"),
        NoteTemplate(id: "planning", name: "Sprint Planning"),
        NoteTemplate(id: "design-review", name: "Design Review"),
        NoteTemplate(id: "retrospective", name: "Retrospective"),
    ]

    public static func named(_ id: String) -> NoteTemplate? { all.first { $0.id == id } }
}

/// Prompts for merging notes with a transcript and for titling a meeting.
public enum NotePrompts {
    public static func mergeSystem(template: NoteTemplate) -> String {
        let meetingTypeHint =
            template.id == "general" ? "" : "\nThis was a \"\(template.name)\" meeting. Structure and label the notes accordingly.\n"
        return """
            You are a precise meeting-notes assistant. You have two inputs:
            1. HUMAN NOTES: notes written by a human during the meeting (may be incomplete or rough)
            2. TRANSCRIPT: the full meeting transcript
            \(meetingTypeHint)
            Your job is to produce polished final meeting notes that:
            - Respect and preserve the human's structure and wording where possible
            - Fill in gaps, decisions, and context from the transcript that the human missed
            - Extract all action items into a structured table
            - Are written in clean, professional Markdown

            IMPORTANT: Output ONLY the raw Markdown. Begin with "# Meeting Notes". No preamble or closing remarks.

            Rules:
            1. Prefer human notes wording over transcript wording when both cover the same point.
            2. Add context from transcript only if it adds meaningful new information.
            3. Do NOT invent facts.
            4. Action items: owner (if stated), task, due date. Unknown owners → "Unassigned".
            5. Keep the summary to 3–5 sentences.
            6. If a section has nothing to add, write "None noted."
            7. Transcript lines are `[mm:ss] Speaker: text`. Attribute decisions and action items to speakers by name when labelled; `Me` is the note-taker.

            Use EXACTLY this structure:

            # Meeting Notes

            ## Summary
            <3-5 sentence summary>

            ## Decisions
            - <decision>

            ## Action Items
            | Owner | Task | Due |
            |-------|------|-----|
            | <name or Unassigned> | <task> | <due or —> |

            ## Callouts / Risks
            - <callout or risk>

            ## Open Questions
            - <question>
            """
    }

    public static func mergeUser(humanNotes: String, transcript: String, transcriptHeading: String = "TRANSCRIPT:") -> String {
        """
        ---
        HUMAN NOTES:
        \(humanNotes.isEmpty ? "(No human notes taken)" : humanNotes)

        ---
        \(transcriptHeading)
        \(transcript.isEmpty ? "(No transcript available)" : transcript)
        """
    }

    public static let chunkSystem =
        "Extract concise bullet notes from this meeting transcript excerpt: key points, decisions, action items (owner, task, due), risks, open questions. Output only Markdown bullets."

    public static func title(transcript: String, notes: String) -> String {
        let context = [
            notes.isEmpty ? "" : "NOTES:\n\(notes.prefix(600))",
            transcript.isEmpty ? "" : "TRANSCRIPT EXCERPT:\n\(transcript.prefix(800))",
        ].filter { !$0.isEmpty }.joined(separator: "\n\n")
        return """
            Based on the meeting content below, generate a concise, descriptive meeting title (5–10 words).

            Output ONLY the title text. No quotes, no punctuation at the end, no explanation.

            \(context)

            """
    }
}
