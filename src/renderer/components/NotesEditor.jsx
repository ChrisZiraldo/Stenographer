import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { TemplateMenu } from './TemplateMenu.jsx';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';

// ── Slash Command Extension ───────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { id: 'todo',        icon: '☐', label: 'Todo',           desc: 'Add a task item',        action: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'heading1',   icon: 'H1', label: 'Heading 1',      desc: 'Large heading',           action: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'heading2',   icon: 'H2', label: 'Heading 2',      desc: 'Medium heading',          action: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'bullet',     icon: '•',  label: 'Bullet list',    desc: 'Unordered list',          action: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'blockquote', icon: '"',  label: 'Blockquote',     desc: 'Quote block',             action: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'divider',    icon: '—',  label: 'Divider',        desc: 'Horizontal rule',         action: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: 'ai-cleanup', icon: '✨', label: 'Clean up',       desc: 'AI: tidy this text',      action: null, aiCommand: 'clean-up' },
  { id: 'ai-sum',     icon: '⚡', label: 'Summarize',      desc: 'AI: bullet summary',      action: null, aiCommand: 'summarize' },
  { id: 'ai-actions', icon: '📋', label: 'Action items',   desc: 'AI: extract action items',action: null, aiCommand: 'action-items' },
];

function SlashMenu({ items, selectedIndex, onSelect, position }) {
  return (
    <div
      className="slash-command-menu fixed z-[100]"
      style={{ top: position.top, left: position.left }}
    >
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`slash-command-item ${i === selectedIndex ? 'is-selected' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onSelect(item); }}
        >
          <div className="icon">{item.icon}</div>
          <div>
            <div className="label">{item.label}</div>
            <div className="desc">{item.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Formatting toolbar ────────────────────────────────────────────────────────

function ToolBtn({ active, disabled, onClick, title, children }) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 6, border: 'none', cursor: disabled ? 'default' : 'pointer',
        background: active ? 'var(--bg-surface3)' : 'transparent',
        color: active ? 'var(--ink)' : 'var(--ink-faint)',
        fontWeight: active ? 700 : 400,
        fontSize: 13, transition: 'background 0.1s, color 0.1s',
        flexShrink: 0,
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = active ? 'var(--bg-surface3)' : 'var(--bg-surface2)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = active ? 'var(--bg-surface3)' : 'transparent'; }}
    >
      {children}
    </button>
  );
}

const Divider = () => (
  <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 3px', flexShrink: 0 }} />
);

function FormatToolbar({ editor, onTemplate }) {
  const headingLevel = [1, 2, 3].find((l) => editor.isActive('heading', { level: l })) ?? 0;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap',
      padding: '4px 6px', marginBottom: 4,
      background: 'var(--bg-surface2)', borderRadius: 8,
      border: '1px solid var(--border-soft)',
      flexShrink: 0,
    }}>
      {/* Template picker */}
      {onTemplate && <TemplateMenu onSelect={onTemplate} />}

      {onTemplate && <Divider />}

      {/* Heading selector */}
      <select
        value={headingLevel}
        onChange={(e) => {
          const l = Number(e.target.value);
          if (l === 0) editor.chain().focus().setParagraph().run();
          else editor.chain().focus().toggleHeading({ level: l }).run();
        }}
        style={{ fontSize: 12, color: 'var(--ink)', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 4px', cursor: 'pointer', outline: 'none', marginRight: 2, height: 26 }}
      >
        <option value={0}>Body</option>
        <option value={1}>H1</option>
        <option value={2}>H2</option>
        <option value={3}>H3</option>
      </select>

      <Divider />

      <ToolBtn active={editor.isActive('bold')}      onClick={() => editor.chain().focus().toggleBold().run()}      title="Bold (⌘B)"><b>B</b></ToolBtn>
      <ToolBtn active={editor.isActive('italic')}    onClick={() => editor.chain().focus().toggleItalic().run()}    title="Italic (⌘I)"><i>I</i></ToolBtn>
      <ToolBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline (⌘U)"><u>U</u></ToolBtn>
      <ToolBtn active={editor.isActive('strike')}    onClick={() => editor.chain().focus().toggleStrike().run()}    title="Strikethrough"><s style={{ textDecoration: 'line-through' }}>S</s></ToolBtn>
      <ToolBtn active={editor.isActive('code')}      onClick={() => editor.chain().focus().toggleCode().run()}      title="Inline code">
        <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{`</>`}</span>
      </ToolBtn>

      <Divider />

      <ToolBtn active={editor.isActive('bulletList')}  onClick={() => editor.chain().focus().toggleBulletList().run()}  title="Bullet list">
        <span style={{ fontSize: 15, lineHeight: 1 }}>≡</span>
      </ToolBtn>
      <ToolBtn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
        <span style={{ fontSize: 11, fontWeight: 700 }}>1.</span>
      </ToolBtn>
      <ToolBtn active={editor.isActive('taskList')}    onClick={() => editor.chain().focus().toggleTaskList().run()}    title="Task list">
        <span style={{ fontSize: 13 }}>☐</span>
      </ToolBtn>
      <ToolBtn active={editor.isActive('blockquote')}  onClick={() => editor.chain().focus().toggleBlockquote().run()}  title="Blockquote">
        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'Georgia, serif' }}>"</span>
      </ToolBtn>

      <Divider />

      <ToolBtn active={false} onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Divider">
        <span style={{ fontSize: 11, letterSpacing: -1 }}>——</span>
      </ToolBtn>

      <Divider />

      <ToolBtn active={false} disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} title="Undo (⌘Z)">
        <span style={{ fontSize: 14 }}>↩</span>
      </ToolBtn>
      <ToolBtn active={false} disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} title="Redo (⌘⇧Z)">
        <span style={{ fontSize: 14 }}>↪</span>
      </ToolBtn>
    </div>
  );
}

// ── NotesEditor ───────────────────────────────────────────────────────────────

export function NotesEditor({ meetingId, initialDoc, onDocChange, onTodosChange, editorRef: externalEditorRef, onTemplate }) {
  const [slashMenu, setSlashMenu] = useState(null); // { query, items, pos, selectedIndex }
  const [isAiRunning, setIsAiRunning] = useState(false);
  const debounceRef    = useRef(null);
  const editorRef      = useRef(null);
  // True once the user has actually typed something in the current meeting.
  // Gates flush-on-unmount saves so an un-hydrated/empty editor can never
  // overwrite saved notes — this guards against React StrictMode (which does
  // mount→unmount→remount) and against switching meetings without typing (which
  // would otherwise flush stale content from the previous meeting). [C8]
  const hasEditedRef = useRef(false);
  // Keep meetingId and slash state in refs so debounced/handler callbacks
  // always read the current value without capturing stale closures.
  const meetingIdRef          = useRef(meetingId);
  const slashMenuRef          = useRef(null);
  const handleSelectSlashRef  = useRef(null);
  meetingIdRef.current = meetingId;
  slashMenuRef.current = slashMenu;

  const handleAiCommand = useCallback(async (commandId, editor) => {
    setIsAiRunning(true);
    const selectedText = editor.state.selection.empty
      ? editor.getText().slice(0, 1000)
      : editor.state.doc.textBetween(
          editor.state.selection.from,
          editor.state.selection.to,
        );

    let accumulated = '';
    window.api.onAiCommandChunk((text) => { accumulated += text; });

    try {
      const res = await window.api.aiCommand({ prompt: buildSlashPrompt(commandId, selectedText) });
      // Guard: editor may have been destroyed while awaiting [C7]
      if (res.ok && accumulated && !editor.isDestroyed) {
        editor.chain().focus().insertContent(`\n\n${accumulated}\n\n`).run();
      }
    } finally {
      window.api.offAiCommandChunk();
      setIsAiRunning(false);
    }
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start typing your notes… (type / for commands)' }),
    ],
    content: (() => {
      if (!initialDoc || initialDoc === '{}') return '';
      try { return JSON.parse(initialDoc); } catch { return initialDoc; }
    })(),
    onUpdate: ({ editor }) => {
      const json = editor.getJSON();
      const text = editor.getText();

      // Mark dirty on every real user edit. onUpdate only fires for actual
      // typing — programmatic setContent/clearContent use emitUpdate:false. [C8]
      hasEditedRef.current = true;

      // Snapshot meetingId at schedule time so the debounce always writes to the
      // correct meeting even if meetingId changes before the timeout fires. [C1]
      const mid = meetingIdRef.current;

      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (mid) {
          window.api.db.saveNoteDoc(mid, {
            humanDocJson: JSON.stringify(json),
            humanDocText: text,
          }).catch((err) => console.warn('[NotesEditor] saveNoteDoc failed:', err.message)); // [C5]
        }
        onDocChange?.({ json, text });

        // Sync task items → todos
        const tasks = extractTasks(json);
        onTodosChange?.(tasks);
        syncTodosToDb(mid, tasks);
      }, 800);
    },
    editorProps: {
      // Use refs so this handler always sees current slashMenu/handleSelectSlash state
      // without needing to be recreated when those values change.
      handleKeyDown: (view, event) => {
        const menu = slashMenuRef.current;
        if (menu) {
          if (event.key === 'ArrowDown') {
            setSlashMenu((m) => m && ({ ...m, selectedIndex: (m.selectedIndex + 1) % m.items.length }));
            return true;
          }
          if (event.key === 'ArrowUp') {
            setSlashMenu((m) => m && ({ ...m, selectedIndex: (m.selectedIndex - 1 + m.items.length) % m.items.length }));
            return true;
          }
          if (event.key === 'Enter') {
            if (menu.items[menu.selectedIndex]) {
              handleSelectSlashRef.current?.(menu.items[menu.selectedIndex]);
            }
            return true;
          }
          if (event.key === 'Escape') { setSlashMenu(null); return true; }
        }
        return false;
      },
    },
  });

  editorRef.current = editor;
  if (externalEditorRef) externalEditorRef.current = editor;

  // Clear the external ref when this component unmounts so callers
  // don't try to call methods on a destroyed TipTap editor instance.
  useEffect(() => {
    return () => {
      if (externalEditorRef) externalEditorRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When meetingId changes, flush any pending save for the leaving meeting so the
  // last keystrokes are not lost. Capture meetingId in the effect body so the cleanup
  // still has access to the old id after meetingIdRef updates on the new render. [C2]
  useEffect(() => {
    const capturedMid = meetingId;
    return () => {
      clearTimeout(debounceRef.current);
      // Only flush when the user actually typed something in this meeting.
      // An un-hydrated editor (StrictMode remount) or a meeting the user
      // opened but never edited must not overwrite saved notes. [C8]
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed && capturedMid && hasEditedRef.current) {
        const json = ed.getJSON();
        const text = ed.getText();
        void window.api.db.saveNoteDoc(capturedMid, {
          humanDocJson: JSON.stringify(json),
          humanDocText: text,
        }).catch((err) => console.warn('[NotesEditor] flush saveNoteDoc failed:', err.message));
        void syncTodosToDb(capturedMid, extractTasks(json));
      }
    };
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also flush on unmount (e.g. user navigates back to library) [C2]
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      const ed = editorRef.current;
      const mid = meetingIdRef.current;
      // Only flush when the user actually typed something. [C8]
      if (ed && !ed.isDestroyed && mid && hasEditedRef.current) {
        const json = ed.getJSON();
        const text = ed.getText();
        void window.api.db.saveNoteDoc(mid, {
          humanDocJson: JSON.stringify(json),
          humanDocText: text,
        }).catch((err) => console.warn('[NotesEditor] unmount flush failed:', err.message));
        void syncTodosToDb(mid, extractTasks(json));
      }
    };
  }, []);

  // Slash command detection on text changes
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      const { state } = editor;
      const { from } = state.selection;
      const textBefore = state.doc.textBetween(Math.max(0, from - 30), from, '\n', '\0');
      const match = textBefore.match(/\/([\w-]*)$/);

      if (match) {
        const query = match[1].toLowerCase();
        const items = SLASH_COMMANDS.filter((c) =>
          c.label.toLowerCase().includes(query) || c.id.includes(query)
        );
        if (items.length) {
          // Get cursor position
          const coords = editor.view.coordsAtPos(from);
          setSlashMenu({ query, items, selectedIndex: 0, position: { top: coords.bottom + 4, left: coords.left } });
          return;
        }
      }
      setSlashMenu(null);
    };
    editor.on('update', onUpdate);
    return () => editor.off('update', onUpdate);
  }, [editor]);

  const handleSelectSlash = useCallback((item) => {
    if (!editor) return;
    setSlashMenu(null);

    // Delete the /command text (support hyphenated commands like /action-items)
    const { state } = editor;
    const { from } = state.selection;
    const textBefore = state.doc.textBetween(Math.max(0, from - 30), from, '\n', '\0');
    const match = textBefore.match(/\/([\w-]*)$/);
    if (match) {
      editor.chain().focus().deleteRange({ from: from - match[0].length, to: from }).run();
    }

    if (item.aiCommand) {
      handleAiCommand(item.aiCommand, editor);
    } else {
      item.action?.(editor);
    }
  }, [editor, handleAiCommand]);

  // Keep the ref in sync so the editor's handleKeyDown can call the current callback
  handleSelectSlashRef.current = handleSelectSlash;

  // Load initial doc when meetingId or initialDoc changes (initialDoc arrives async after DB load).
  // Also depends on `editor` so it runs once the editor is ready.
  useEffect(() => {
    if (!editor) return;
    if (!initialDoc || initialDoc === '{}') {
      // On meeting switch with empty doc, explicitly clear the editor
      editor.commands.clearContent(false);
      // Programmatic load is not a user edit — reset dirty flag so the unmount
      // flush won't save this blank state over the DB. [C8]
      hasEditedRef.current = false;
      return;
    }
    try {
      const parsed = JSON.parse(initialDoc);
      if (parsed?.type === 'doc') {
        // TipTap v3 setContent uses an options object, not a bare boolean
        editor.commands.setContent(parsed, { emitUpdate: false });
      } else {
        // Parsed but not a doc node — clear so stale content doesn't bleed through [C4]
        editor.commands.clearContent(false);
      }
      // Programmatic content load is not a user edit — reset dirty flag. [C8]
      hasEditedRef.current = false;
    } catch { /* raw text — leave as-is */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, initialDoc, editor]);

  return (
    <div className="relative h-full flex flex-col">
      {/* Formatting toolbar */}
      {editor && <FormatToolbar editor={editor} onTemplate={onTemplate} />}

      {isAiRunning && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5 text-[11px] text-[#7c5fc2] dark:text-[#b39de8] bg-[#ede8f8] dark:bg-[#2a2040] px-2.5 py-1.5 rounded-full border border-[#d8d0f0] dark:border-[#3d3060]">
          <div className="w-3 h-3 border-2 border-[#7c5fc2] border-t-transparent rounded-full animate-spin" />
          AI thinking…
        </div>
      )}

      <EditorContent
        editor={editor}
        className="flex-1 overflow-y-auto text-[#1a1814] dark:text-[#e8e4db] text-sm leading-relaxed tiptap-editor"
      />

      {slashMenu && (
        <SlashMenu
          items={slashMenu.items}
          selectedIndex={slashMenu.selectedIndex}
          onSelect={handleSelectSlash}
          position={slashMenu.position}
        />
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTasks(doc) {
  const tasks = [];

  // Recursively collect all text from a node tree (handles taskItem > paragraph > text)
  function getTextContent(node) {
    if (node.type === 'text') return node.text ?? '';
    return (node.content ?? []).map(getTextContent).join('');
  }

  function walk(node) {
    if (node.type === 'taskItem') {
      const text = getTextContent(node).trim();
      if (text) tasks.push({ text, done: node.attrs?.checked ?? false });
    }
    // Continue walking to find nested taskItems (TipTap supports nested task lists)
    node.content?.forEach(walk);
  }
  doc?.content?.forEach(walk);
  return tasks;
}

async function syncTodosToDb(meetingId, tasks) {
  if (!meetingId) return;
  try {
    // Replace-all semantics: delete human todos then re-insert from editor order.
    // This handles reordering, deletion, and unchecking correctly without orphans.
    // AI-sourced todos are left untouched by replaceHumanTodos.
    await window.api.db.replaceHumanTodos(meetingId, tasks);
  } catch (err) {
    console.warn('[NotesEditor] syncTodosToDb failed:', err.message);
  }
}

function buildSlashPrompt(command, selectedText) {
  const prompts = {
    'clean-up':    `Clean up and improve the following meeting notes. Fix grammar, improve clarity. Output ONLY the improved text:\n\n${selectedText}`,
    'summarize':   `Summarize the following in 2-3 concise bullet points. Output ONLY the bullets:\n\n${selectedText}`,
    'action-items':`Extract action items from this text. Format as markdown table: Owner | Task | Due. Output ONLY the table:\n\n${selectedText}`,
  };
  return prompts[command] ?? `${command}\n\n${selectedText}`;
}
