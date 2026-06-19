/**
 * Prompt builders for the Cursor SDK agent calls.
 */

/**
 * Builds the final meeting-notes prompt (transcript-only path).
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
 * Builds the AI merge prompt — takes BOTH human notes and transcript,
 * asks the model to merge them (respecting human structure, filling gaps from transcript,
 * extracting action items).
 */
export function buildMergePrompt(humanNotesText, transcriptText) {
  return `You are a precise meeting-notes assistant. You have two inputs:
1. HUMAN NOTES: notes written by a human during the meeting (may be incomplete or rough)
2. TRANSCRIPT: the full meeting transcript

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
HUMAN NOTES:
${humanNotesText || '(No human notes taken)'}

---
TRANSCRIPT:
${transcriptText || '(No transcript available)'}
`;
}

/**
 * Builds the auto-title prompt — generates a concise meeting title.
 */
export function buildAutoTitlePrompt(transcriptText, notesText) {
  const context = [
    notesText ? `NOTES:\n${notesText.slice(0, 600)}` : '',
    transcriptText ? `TRANSCRIPT EXCERPT:\n${transcriptText.slice(0, 800)}` : '',
  ].filter(Boolean).join('\n\n');

  return `Based on the meeting content below, generate a concise, descriptive meeting title (5–10 words).

Output ONLY the title text. No quotes, no punctuation at the end, no explanation.

${context}
`;
}

/**
 * Builds the rolling "so far" summary prompt.
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

/**
 * Builds a prompt for an inline AI slash command in the editor.
 */
export function buildSlashCommandPrompt(command, selectedText, context) {
  const prompts = {
    'clean-up': `Clean up and improve the following meeting notes text. Fix grammar, improve clarity, and make it more professional. Output ONLY the improved text with no preamble:\n\n${selectedText || context}`,
    'summarize': `Summarize the following text in 2–3 concise bullet points. Output ONLY the bullet points:\n\n${selectedText || context}`,
    'expand': `Expand the following brief note into a more detailed paragraph. Output ONLY the expanded text:\n\n${selectedText || context}`,
    'action-items': `Extract all action items from the following text. Format as a markdown table with columns: Owner, Task, Due. Output ONLY the table:\n\n${selectedText || context}`,
  };
  return prompts[command] ?? `${command}\n\n${selectedText || context}`;
}
