/**
 * Converts a markdown string to a TipTap/ProseMirror JSON document.
 * Uses marked to produce HTML, then generateJSON to parse into TipTap nodes.
 */
import { marked } from 'marked';
import { generateJSON } from '@tiptap/core';
import { buildEditorExtensions } from './editorExtensions.js';

const _extensions = buildEditorExtensions({});

/**
 * @param {string} md - Markdown source
 * @returns {{ json: string, text: string }}
 */
export function markdownToTiptapJSON(md) {
  if (!md) return { json: '{}', text: '' };

  const html = marked.parse(md, { async: false });
  const doc = generateJSON(html, _extensions);

  // Plain-text mirror: walk all text nodes
  function extractText(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text ?? '';
    return (node.content ?? []).map(extractText).join('');
  }
  const text = extractText(doc).trim();

  return { json: JSON.stringify(doc), text };
}
