import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { FormatToolbar } from './NotesEditor.jsx';
import { buildEditorExtensions } from '../lib/editorExtensions.js';

/**
 * Editable rich-text editor for the Final Notes tab.
 * Mirrors NotesEditor's save/flush guards but omits todo-sync, slash commands,
 * and template picker since those are My Notes concepts.
 */
export function FinalNotesEditor({ meetingId, initialDoc, editorRef: externalEditorRef }) {
  const debounceRef  = useRef(null);
  const editorRef    = useRef(null);
  const meetingIdRef = useRef(meetingId);
  meetingIdRef.current = meetingId;

  // Only flush on unmount when the user actually typed something — prevents
  // a blank programmatic load from overwriting saved content. [C8]
  const hasEditedRef = useRef(false);

  const editor = useEditor({
    extensions: buildEditorExtensions({ placeholder: 'Your final notes will appear here after generating…' }),
    content: (() => {
      if (!initialDoc || initialDoc === '{}') return '';
      try { return JSON.parse(initialDoc); } catch { return initialDoc; }
    })(),
    onUpdate: ({ editor }) => {
      hasEditedRef.current = true;
      const mid = meetingIdRef.current;
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (mid) {
          window.api.db.saveFinalDoc(mid, {
            finalDocJson: JSON.stringify(editor.getJSON()),
            finalDocText: editor.getText(),
          }).catch((err) => console.warn('[FinalNotesEditor] saveFinalDoc failed:', err.message));
        }
      }, 800);
    },
  });

  editorRef.current = editor;
  if (externalEditorRef) externalEditorRef.current = editor;

  // Clear external ref on unmount so callers don't call methods on a destroyed instance.
  useEffect(() => {
    return () => {
      if (externalEditorRef) externalEditorRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the last meeting flushed to prevent the two cleanup paths from double-saving. [F6]
  const lastFlushedMidRef = useRef(null);

  // Flush pending save when the meeting changes (switching notes). [C2]
  useEffect(() => {
    const capturedMid = meetingId;
    return () => {
      clearTimeout(debounceRef.current);
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed && capturedMid && hasEditedRef.current) {
        lastFlushedMidRef.current = capturedMid;
        void window.api.db.saveFinalDoc(capturedMid, {
          finalDocJson: JSON.stringify(ed.getJSON()),
          finalDocText: ed.getText(),
        }).catch((err) => console.warn('[FinalNotesEditor] flush saveFinalDoc failed:', err.message));
      }
    };
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush on unmount (e.g. navigating back to library). Skip if [meetingId] cleanup
  // already flushed this meeting to avoid a duplicate write. [C2, F6]
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      const ed = editorRef.current;
      const mid = meetingIdRef.current;
      if (ed && !ed.isDestroyed && mid && hasEditedRef.current && lastFlushedMidRef.current !== mid) {
        void window.api.db.saveFinalDoc(mid, {
          finalDocJson: JSON.stringify(ed.getJSON()),
          finalDocText: ed.getText(),
        }).catch((err) => console.warn('[FinalNotesEditor] unmount flush failed:', err.message));
      }
    };
  }, []);

  // Load content when meetingId or initialDoc changes (initialDoc arrives async after DB load). [C4]
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // Skip hydration if the user has already typed — an async DB load arriving late
    // must not clobber in-progress edits. [C1]
    if (hasEditedRef.current) return;
    if (!initialDoc || initialDoc === '{}') {
      editor.commands.clearContent(false);
      hasEditedRef.current = false;
      return;
    }
    try {
      const parsed = JSON.parse(initialDoc);
      if (parsed?.type === 'doc') {
        editor.commands.setContent(parsed, { emitUpdate: false });
      } else {
        editor.commands.clearContent(false);
      }
      hasEditedRef.current = false;
    } catch { /* raw text — leave as-is */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, initialDoc, editor]);

  return (
    <div className="relative h-full flex flex-col">
      {editor && <FormatToolbar editor={editor} />}
      <EditorContent
        editor={editor}
        className="flex-1 overflow-y-auto text-[#1a1814] dark:text-[#e8e4db] text-sm leading-relaxed tiptap-editor"
      />
    </div>
  );
}
