/**
 * Prompt builders for the Cursor SDK agent calls.
 *
 * Both notes generation and rolling summaries use the same streaming child
 * process (generate-notes.cjs).  The prompts tell the model to output its
 * response as raw text — no file writing, no preamble — so the output can
 * be streamed directly into the UI.
 */

/**
 * Builds the final meeting-notes prompt.
 * The model is instructed to output raw Markdown as its response text so we
 * can stream it into the notes panel and save it ourselves.
 *
 * @param {string} transcriptText
 * @returns {string}
 */
export function buildNotesPrompt(transcriptText) {
  return `You are a precise meeting-notes assistant. Read the transcript below and output structured Markdown meeting notes.

IMPORTANT: Output ONLY the raw Markdown in your response. Begin directly with "# Meeting Notes". Do not use any tools or write any files. Do not add any preamble, commentary, or closing remarks outside the Markdown.

Rules:
1. Only include information explicitly present in the transcript.
2. Do NOT invent facts, attendees, decisions, or dates.
3. Action items must include: owner (if stated), task, due date (if mentioned). Unknown owners → "Unassigned".
4. Callouts/Risks = things explicitly flagged as a concern, blocker, or risk.
5. Open Questions = questions raised but not fully answered.
6. Keep the summary to 3–5 sentences.
7. Use standard GitHub-flavoured Markdown.
8. If a section has nothing to add, write "None noted." under it.

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

---
TRANSCRIPT:
${transcriptText}
`;
}

/**
 * Builds the rolling "so far" summary prompt.
 * Only the previous summary + new delta are sent, keeping token cost bounded
 * regardless of total meeting length.
 *
 * @param {string} prevSummary  - Last generated summary (empty if first tick)
 * @param {string} newText      - New transcript text since the last tick
 * @returns {string}
 */
export function buildSummaryPrompt(prevSummary, newText) {
  return `You are a precise meeting-notes assistant tracking a live meeting. Update the running bullet-point summary with the new transcript excerpt.

IMPORTANT: Output ONLY a bulleted list of key points discussed so far. One line per bullet. Use "- " to start each bullet. No headings, no prose paragraphs, no commentary before or after the list. Keep each bullet concise (under 15 words). Remove or merge older bullets that are now superseded by clearer information.

Current summary:
${prevSummary || '(Meeting just started — no summary yet.)'}

New transcript excerpt:
${newText}
`;
}
