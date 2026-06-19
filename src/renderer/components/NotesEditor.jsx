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
  const debounceRef = useRef(null);
  const editorRef = useRef(null);

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
      if (res.ok && accumulated) {
        // Insert AI result as new paragraph after cursor
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

      // Autosave (debounced 800ms)
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (meetingId) {
          window.api.db.saveNoteDoc(meetingId, {
            humanDocJson: JSON.stringify(json),
            humanDocText: text,
          });
        }
        onDocChange?.({ json, text });

        // Sync task items → todos
        const tasks = extractTasks(json);
        onTodosChange?.(tasks);
        syncTodosToDb(meetingId, tasks);
      }, 800);
    },
    editorProps: {
      handleKeyDown: (view, event) => {
        if (slashMenu) {
          if (event.key === 'ArrowDown') {
            setSlashMenu((m) => m && ({ ...m, selectedIndex: (m.selectedIndex + 1) % m.items.length }));
            return true;
          }
          if (event.key === 'ArrowUp') {
            setSlashMenu((m) => m && ({ ...m, selectedIndex: (m.selectedIndex - 1 + m.items.length) % m.items.length }));
            return true;
          }
          if (event.key === 'Enter') {
            if (slashMenu.items[slashMenu.selectedIndex]) {
              handleSelectSlash(slashMenu.items[slashMenu.selectedIndex]);
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

  // Slash command detection on text changes
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      const { state } = editor;
      const { from } = state.selection;
      const textBefore = state.doc.textBetween(Math.max(0, from - 30), from, '\n', '\0');
      const match = textBefore.match(/\/(\w*)$/);

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

    // Delete the /command text
    const { state } = editor;
    const { from } = state.selection;
    const textBefore = state.doc.textBetween(Math.max(0, from - 30), from, '\n', '\0');
    const match = textBefore.match(/\/(\w*)$/);
    if (match) {
      editor.chain().focus().deleteRange({ from: from - match[0].length, to: from }).run();
    }

    if (item.aiCommand) {
      handleAiCommand(item.aiCommand, editor);
    } else {
      item.action?.(editor);
    }
  }, [editor, handleAiCommand]);

  // Load initial doc when meetingId or initialDoc changes (initialDoc arrives async after DB load)
  useEffect(() => {
    if (!editor || !initialDoc || initialDoc === '{}') return;
    try {
      const parsed = JSON.parse(initialDoc);
      if (parsed?.type === 'doc') {
        // setContent with emitUpdate=false so autosave isn't triggered by the load
        editor.commands.setContent(parsed, false);
      }
    } catch { /* raw text — leave as-is */ }
  }, [meetingId, initialDoc]);

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
  function walk(node) {
    if (node.type === 'taskItem') {
      const text = node.content?.map((n) => n.text ?? '').join('') ?? '';
      if (text.trim()) tasks.push({ text: text.trim(), done: node.attrs?.checked ?? false });
    }
    node.content?.forEach(walk);
  }
  doc?.content?.forEach(walk);
  return tasks;
}

async function syncTodosToDb(meetingId, tasks) {
  if (!meetingId) return;
  try {
    // Get existing AI/human todos from DB to avoid overwriting AI-created ones
    const existing = await window.api.db.listTodos({ meetingId });
    const humanExisting = existing.filter((t) => t.source === 'human');

    // Upsert tasks from editor (by position — simplistic sync)
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const match = humanExisting[i];
      await window.api.db.upsertTodo({
        id: match?.id,
        meetingId,
        text: task.text,
        done: task.done,
        source: 'human',
        position: i,
      });
    }
  } catch { /* ignore sync errors */ }
}

function buildSlashPrompt(command, selectedText) {
  const prompts = {
    'clean-up':    `Clean up and improve the following meeting notes. Fix grammar, improve clarity. Output ONLY the improved text:\n\n${selectedText}`,
    'summarize':   `Summarize the following in 2-3 concise bullet points. Output ONLY the bullets:\n\n${selectedText}`,
    'action-items':`Extract action items from this text. Format as markdown table: Owner | Task | Due. Output ONLY the table:\n\n${selectedText}`,
  };
  return prompts[command] ?? `${command}\n\n${selectedText}`;
}
