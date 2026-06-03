/**
 * Builds the prompt sent to the Cursor SDK agent that generates meeting notes.
 * Receiving the full transcript text inline avoids any file-path resolution issues
 * between the renderer and the SDK's working directory.
 */
export function buildNotesPrompt(transcriptText, outputPath) {
  return `You are a precise meeting-notes assistant. Read the transcript below and write a structured Markdown notes file to: ${outputPath}

Rules:
1. Only include information explicitly present in the transcript.
2. Do NOT invent facts, attendees, decisions, or dates.
3. Action items must include: owner (if stated), task, due date (if mentioned). Unknown owners → "Unassigned".
4. Callouts/Risks = things explicitly flagged as a concern, blocker, or risk.
5. Open Questions = questions raised but not fully answered.
6. Keep the summary to 3–5 sentences.
7. Use standard GitHub-flavoured Markdown.
8. If a section has nothing to add, write "None noted." under it.

Use EXACTLY this structure in the file:

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

---
TRANSCRIPT:
${transcriptText}
`;
}
