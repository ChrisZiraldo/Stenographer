import { useState, useEffect, useRef } from 'react';
import { FileText, ChevronDown, X, Sparkles, BookmarkPlus } from 'lucide-react';

// ── Built-in templates ────────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: 'blank',
    label: 'Blank',
    doc: { type: 'doc', content: [{ type: 'paragraph' }] },
  },
  {
    id: '1-1',
    label: '1:1 Meeting',
    doc: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Agenda' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Updates' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Blockers' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Action Items' }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] },
      ],
    },
  },
  {
    id: 'standup',
    label: 'Daily Standup',
    doc: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Yesterday' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Today' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Blockers' }] },
        { type: 'paragraph' },
      ],
    },
  },
  {
    id: 'interview',
    label: 'Interview',
    doc: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Candidate' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Name: ' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Role: ' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Strengths' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Concerns' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Decision' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Follow-ups' }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] },
      ],
    },
  },
  {
    id: 'planning',
    label: 'Sprint Planning',
    doc: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goals' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Capacity' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Selected Items' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Risks' }] },
        { type: 'paragraph' },
      ],
    },
  },
  {
    id: 'design-review',
    label: 'Design Review',
    doc: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Context / Goals' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Proposal' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Feedback' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Concerns / Risks' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Decisions' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Action Items' }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] },
      ],
    },
  },
  {
    id: 'retrospective',
    label: 'Retrospective',
    doc: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'What Went Well' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: "What Didn't Go Well" }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Action Items' }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] },
      ],
    },
  },
];

// ── TipTap doc builder from AI section list ───────────────────────────────────

function sectionsToDoc(sections) {
  const content = [];
  for (const { heading, block } of sections) {
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: heading }],
      });
    }
    if (block === 'bullet') {
      content.push({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] });
    } else if (block === 'task') {
      content.push({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] });
    } else {
      content.push({ type: 'paragraph' });
    }
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

function parseTemplateSections(raw) {
  // Strip markdown code fences if present
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].heading) return parsed;
  } catch {
    // Try to find a JSON array anywhere in the response
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr) && arr.length > 0 && arr[0].heading) return arr;
      } catch {}
    }
  }
  return null;
}

function buildTemplatePrompt(description) {
  return `You are a meeting-notes structure assistant. Given a meeting type description, output a JSON array of sections for that meeting's note template.

Each section is an object with:
- "heading": string — the section title
- "block": one of "paragraph", "bullet", or "task"

Use "task" for action items, "bullet" for lists of items, "paragraph" for free-form text.

Output ONLY the raw JSON array — no markdown fences, no explanation.

Example output:
[{"heading":"Goals","block":"paragraph"},{"heading":"Discussion","block":"bullet"},{"heading":"Action Items","block":"task"}]

Meeting type: ${description}
`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TemplateMenu({ onSelect, editor }) {
  const [open, setOpen] = useState(false);
  const [customTemplates, setCustomTemplates] = useState(() => {
    try { return JSON.parse(localStorage.getItem('steno:templates') || '[]'); } catch { return []; }
  });
  // mode: null | 'save' | 'generate'
  const [mode, setMode] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const [isAiRunning, setIsAiRunning] = useState(false);
  const [aiError, setAiError] = useState(null);
  const inputRef = useRef(null);

  // Load custom templates from DB on mount, merging with the localStorage cache
  useEffect(() => {
    window.api?.db?.getTemplates?.().then((rows) => {
      if (!rows?.length) return;
      setCustomTemplates(rows);
      localStorage.setItem('steno:templates', JSON.stringify(rows));
    }).catch(() => {});
  }, []);

  // Auto-focus the inline input when a mode is activated
  useEffect(() => {
    if (mode) setTimeout(() => inputRef.current?.focus(), 0);
  }, [mode]);

  const persistCustom = (updated) => {
    setCustomTemplates(updated);
    localStorage.setItem('steno:templates', JSON.stringify(updated));
  };

  const resetFooter = () => {
    setMode(null);
    setInputValue('');
    setAiError(null);
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    await window.api.db.deleteTemplate(id).catch(() => {});
    persistCustom(customTemplates.filter((t) => t.id !== id));
  };

  const handleSaveCurrent = async () => {
    const name = inputValue.trim();
    if (!name || !editor) return;
    const id = `tpl_${Date.now()}`;
    const doc_json = JSON.stringify(editor.getJSON());
    await window.api.db.saveTemplate({ id, name, doc_json }).catch(() => {});
    persistCustom([...customTemplates, { id, name, doc_json }]);
    resetFooter();
  };

  const handleGenerate = async () => {
    const desc = inputValue.trim();
    if (!desc) return;
    setIsAiRunning(true);
    setAiError(null);
    let accumulated = '';
    window.api.onAiCommandChunk((text) => { accumulated += text; });
    try {
      const res = await window.api.aiCommand({ prompt: buildTemplatePrompt(desc) });
      if (!res.ok) throw new Error(res.error || 'AI request failed');
      const sections = parseTemplateSections(accumulated);
      if (!sections) throw new Error('Could not parse template from AI response');
      const doc = sectionsToDoc(sections);
      const id = `tpl_${Date.now()}`;
      const name = desc.charAt(0).toUpperCase() + desc.slice(1);
      await window.api.db.saveTemplate({ id, name, doc_json: JSON.stringify(doc) }).catch(() => {});
      persistCustom([...customTemplates, { id, name, doc_json: JSON.stringify(doc) }]);
      onSelect(doc, name);
      setOpen(false);
      resetFooter();
    } catch (err) {
      setAiError(err.message);
    } finally {
      window.api.offAiCommandChunk();
      setIsAiRunning(false);
    }
  };

  const handleKeyDown = (e, action) => {
    if (e.key === 'Enter') { e.preventDefault(); action(); }
    if (e.key === 'Escape') { e.preventDefault(); resetFooter(); }
  };

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen((o) => !o); if (open) resetFooter(); }}
        className="flex items-center gap-1 px-2 py-1 text-xs text-[#9c9285] dark:text-[#7a7268] hover:text-[#1a1814] dark:hover:text-[#e8e4db] rounded-[6px] hover:bg-[#f0ece3] dark:hover:bg-[#2c2820] transition-all cursor-pointer"
      >
        <FileText size={11} /> Template <ChevronDown size={9} className="opacity-60" />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1.5 z-50 w-56 animate-fade-in rounded-[12px] overflow-hidden"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}
          onMouseLeave={() => { if (!mode && !isAiRunning) setOpen(false); }}
        >
          {/* Built-in templates */}
          <div className="py-1.5">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                className="w-full text-left px-3.5 py-2 text-[13px] text-[#1a1814] dark:text-[#e8e4db] hover:bg-[#f5f2e9] dark:hover:bg-[#252018] transition-colors cursor-pointer"
                onClick={() => { onSelect(t.doc, t.label); setOpen(false); resetFooter(); }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Custom templates */}
          {customTemplates.length > 0 && (
            <>
              <div style={{ height: 1, background: 'var(--border)', margin: '0 10px' }} />
              <div className="py-1.5">
                <p className="px-3.5 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-widest text-[#9c9285] dark:text-[#7a7268]">
                  My templates
                </p>
                {customTemplates.map((t) => {
                  let doc;
                  try { doc = JSON.parse(t.doc_json); } catch { doc = { type: 'doc', content: [{ type: 'paragraph' }] }; }
                  return (
                    <div key={t.id} className="group relative flex items-center">
                      <button
                        className="flex-1 text-left px-3.5 py-2 text-[13px] text-[#1a1814] dark:text-[#e8e4db] hover:bg-[#f5f2e9] dark:hover:bg-[#252018] transition-colors cursor-pointer pr-8"
                        onClick={() => { onSelect(doc, t.name); setOpen(false); resetFooter(); }}
                      >
                        {t.name}
                      </button>
                      <button
                        className="absolute right-2 opacity-0 group-hover:opacity-100 flex items-center justify-center w-5 h-5 rounded-[5px] text-[#a09890] dark:text-[#6b6358] hover:bg-[#f5e0d4] dark:hover:bg-[#3a1a10] hover:text-[#b45837] transition-all"
                        onClick={(e) => handleDelete(e, t.id)}
                        title="Delete template"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Footer actions */}
          <div style={{ height: 1, background: 'var(--border)', margin: '0 10px' }} />
          <div className="py-1.5">
            {mode === 'save' ? (
              <div className="px-2.5 py-1.5 flex items-center gap-1.5">
                <input
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, handleSaveCurrent)}
                  placeholder="Template name…"
                  className="flex-1 text-[12px] bg-transparent outline-none border-b border-[#e2ddd4] dark:border-[#524c3e] pb-0.5 text-[#1a1814] dark:text-[#e8e4db] placeholder:text-[#c4bdb5] focus:border-[#5c6e00] transition-colors"
                />
                <button
                  onClick={handleSaveCurrent}
                  disabled={!inputValue.trim()}
                  className="text-[11px] font-medium text-white px-2 py-0.5 rounded-[5px] disabled:opacity-40 transition-colors cursor-pointer"
                  style={{ background: '#5c6e00' }}
                >
                  Save
                </button>
                <button onClick={resetFooter} className="text-[#9c9285] dark:text-[#7a7268] hover:text-[#5c5448] cursor-pointer">
                  <X size={12} />
                </button>
              </div>
            ) : mode === 'generate' ? (
              <div className="px-2.5 py-1.5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <input
                    ref={inputRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, handleGenerate)}
                    placeholder="e.g. coaching session…"
                    disabled={isAiRunning}
                    className="flex-1 text-[12px] bg-transparent outline-none border-b border-[#e2ddd4] dark:border-[#524c3e] pb-0.5 text-[#1a1814] dark:text-[#e8e4db] placeholder:text-[#c4bdb5] focus:border-[#7c5fc2] transition-colors disabled:opacity-60"
                  />
                  {isAiRunning ? (
                    <div className="w-3.5 h-3.5 border-2 border-[#7c5fc2] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  ) : (
                    <>
                      <button
                        onClick={handleGenerate}
                        disabled={!inputValue.trim()}
                        className="text-[11px] font-medium text-white px-2 py-0.5 rounded-[5px] disabled:opacity-40 transition-colors cursor-pointer flex-shrink-0"
                        style={{ background: '#7c5fc2' }}
                      >
                        Go
                      </button>
                      <button onClick={resetFooter} className="text-[#9c9285] dark:text-[#7a7268] hover:text-[#5c5448] cursor-pointer flex-shrink-0">
                        <X size={12} />
                      </button>
                    </>
                  )}
                </div>
                {aiError && (
                  <p className="text-[11px] text-[#b45837] dark:text-[#d4856a] leading-tight">{aiError}</p>
                )}
              </div>
            ) : (
              <div className="flex gap-0.5 px-1.5">
                {editor && (
                  <button
                    className="flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-[8px] text-[12px] text-[#5c5448] dark:text-[#a09890] hover:bg-[#f5f2e9] dark:hover:bg-[#252018] transition-colors cursor-pointer"
                    onClick={() => setMode('save')}
                    title="Save the current note as a reusable template"
                  >
                    <BookmarkPlus size={12} className="text-[#5c6e00] flex-shrink-0" />
                    Save current
                  </button>
                )}
                <button
                  className="flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-[8px] text-[12px] text-[#5c5448] dark:text-[#a09890] hover:bg-[#f5f2e9] dark:hover:bg-[#252018] transition-colors cursor-pointer"
                  onClick={() => setMode('generate')}
                  title="Ask AI to generate a template from a description"
                >
                  <Sparkles size={12} className="text-[#7c5fc2] flex-shrink-0" />
                  AI generate
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { TEMPLATES };
