import { Trash2, Calendar, User } from 'lucide-react';

export function TodoItem({ todo, onToggle, onDelete, showMeeting = false, meetingTitle = '' }) {
  return (
    <div className={`group flex items-start gap-2.5 py-1.5 px-2 rounded-[9px] hover:bg-[#f5f2e9] transition-colors ${todo.done ? 'opacity-50' : ''}`}>
      <button
        onClick={() => onToggle(todo.id)}
        className={`mt-[2px] w-[15px] h-[15px] flex-shrink-0 rounded-[4px] border transition-all cursor-pointer flex items-center justify-center ${
          todo.done
            ? 'bg-[#5c6e00] border-[#5c6e00]'
            : 'border-[#c4bdb5] hover:border-[#5c6e00] bg-transparent'
        }`}
        aria-label={todo.done ? 'Mark undone' : 'Mark done'}
      >
        {todo.done && (
          <svg viewBox="0 0 12 12" fill="none" className="w-2.5 h-2.5">
            <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </button>

      <div className="flex-1 min-w-0">
        <p className={`text-[13px] leading-snug text-[#1a1814] ${todo.done ? 'line-through text-[#c4bdb5] decoration-[#c4bdb5]' : ''}`}>
          {todo.text}
        </p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {todo.owner && (
            <span className="flex items-center gap-0.5 text-[10px] text-[#9c9285]">
              <User size={9} /> {todo.owner}
            </span>
          )}
          {todo.due && (
            <span className="flex items-center gap-0.5 text-[10px] text-[#9c9285]">
              <Calendar size={9} /> {todo.due}
            </span>
          )}
          {todo.source === 'ai' && (
            <span className="text-[9px] bg-[#ede8f8] text-[#7c5fc2] px-1.5 py-0.5 rounded-full font-medium">AI</span>
          )}
          {showMeeting && meetingTitle && (
            <span className="text-[10px] text-[#c4bdb5] truncate max-w-[110px]" title={meetingTitle}>
              {meetingTitle}
            </span>
          )}
        </div>
      </div>

      <button
        onClick={() => onDelete(todo.id)}
        className="opacity-0 group-hover:opacity-100 p-1 rounded-[5px] hover:bg-[#ede9df] text-[#c4bdb5] hover:text-[#b45837] transition-all cursor-pointer"
        aria-label="Delete todo"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}
