import { useState } from 'react';
import { FileText, ChevronDown } from 'lucide-react';

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
];

export function TemplateMenu({ onSelect }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2 py-1 text-xs text-[#9c9285] dark:text-[#7a7268] hover:text-[#1a1814] dark:hover:text-[#e8e4db] rounded-[6px] hover:bg-[#f0ece3] dark:hover:bg-[#2c2820] transition-all cursor-pointer"
      >
        <FileText size={11} /> Template <ChevronDown size={9} className="opacity-60" />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1.5 z-50 w-48 py-1.5 animate-fade-in rounded-[12px]"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}
          onMouseLeave={() => setOpen(false)}
        >
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className="w-full text-left px-3.5 py-2 text-[13px] text-[#1a1814] dark:text-[#e8e4db] hover:bg-[#f5f2e9] dark:hover:bg-[#252018] transition-colors cursor-pointer"
              onClick={() => { onSelect(t.doc); setOpen(false); }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export { TEMPLATES };
