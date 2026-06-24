import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Plus, Search, Home, Mic, Upload, CassetteTape,
  Trash2, X, ChevronDown, ChevronRight,
  Briefcase, User, Users, Calendar, Star, FileText, CheckCircle,
  Settings, Tag, MessageSquare,
  // Icon picker set
  Code, Coffee, BookOpen, Heart, Smile, Award,
  Mail, Bell, Globe, Folder, Archive, Bookmark,
  Hash, Flag, Target, Zap, TrendingUp, MapPin,
  Clock, Music, Pencil, Rocket, Flame, Leaf,
  Monitor, Package, Layers, Phone, Video, Image,
  GripVertical,
} from 'lucide-react';
import { useAppStore } from '../store/appStore.js';
import { useMeetings } from '../hooks/useMeetings.js';
import { Button } from '../components/ui/Button.jsx';
import { SettingsDrawer } from '../components/SettingsDrawer.jsx';
import { isToday, isYesterday, isThisWeek, isThisMonth, differenceInCalendarDays, format } from 'date-fns';

// ── Avatar ────────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  ['#d4a574', '#6b3e26'],
  ['#a8c5a0', '#2d5a27'],
  ['#b8a9c9', '#4a3566'],
  ['#f4c095', '#7a3e00'],
  ['#9ec5d4', '#1a4a5e'],
  ['#d4b896', '#5a3a1a'],
  ['#c4d4a0', '#3a5a1a'],
  ['#d4a0a0', '#5a1a1a'],
];

function getAvatarColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function MeetingAvatar({ title, size = 40 }) {
  const letter = (title || '?')[0].toUpperCase();
  const [bg, text] = getAvatarColor(title || '?');
  return (
    <div
      className="flex items-center justify-center flex-shrink-0 font-semibold select-none"
      style={{
        width: size, height: size,
        background: bg, color: text,
        fontSize: Math.round(size * 0.42),
        borderRadius: '50%',
        letterSpacing: '-0.01em',
      }}
    >
      {letter}
    </div>
  );
}

// ── Date grouping ─────────────────────────────────────────────────────────────

function groupMeetingsByDate(meetings) {
  const groups = [];
  const now = new Date();

  const addGroup = (label, items) => {
    if (items.length > 0) groups.push({ label, items });
  };

  const bucket = (m) => {
    if (!m.created_at) return 'older';
    const d   = new Date(m.created_at);
    const ago = differenceInCalendarDays(now, d);
    if (ago === 0)  return 'today';
    if (ago === 1)  return 'yesterday';
    if (ago <= 6)   return 'week';       // Mon–Sat of the current rolling 7 days
    if (ago <= 13)  return 'last-week';
    if (isThisMonth(d)) return 'month';
    return format(d, 'MMMM yyyy');
  };

  const buckets = {};
  for (const m of meetings) {
    const key = bucket(m);
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(m);
  }

  addGroup('Today',           buckets['today']     ?? []);
  addGroup('Yesterday',       buckets['yesterday'] ?? []);
  addGroup('Earlier this week', buckets['week']    ?? []);
  addGroup('Last week',       buckets['last-week'] ?? []);
  addGroup('Earlier this month', buckets['month']  ?? []);

  // Past months — preserve chronological order (most recent first)
  const pastMonths = Object.entries(buckets)
    .filter(([k]) => !['today','yesterday','week','last-week','month','older'].includes(k))
    .sort(([a], [b]) => new Date(b) - new Date(a));
  for (const [label, items] of pastMonths) {
    addGroup(label, items);
  }

  addGroup('Older', buckets['older'] ?? []);

  return groups;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Single authoritative blank-title constant used everywhere a new note is created. [W16]
const NEW_NOTE_TITLE = 'New Note';

function cleanTitle(raw) {
  if (!raw) return 'Untitled Meeting';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(raw.trim())) return 'Untitled Meeting';
  return raw;
}

function notePreview(meeting) {
  const text = (meeting.human_doc_text || '').trim();
  if (text.length > 4) return text.slice(0, 72).replace(/\s+/g, ' ');
  return null;
}

// ── Space icon map ────────────────────────────────────────────────────────────

const SPACE_META = {
  work:      { Icon: Briefcase, color: '#4a7fcb', bg: '#e8f0fc' },
  personal:  { Icon: User,      color: '#b45837', bg: '#f5e0d4' },
  '1:1':     { Icon: Users,     color: '#7c5fc2', bg: '#ede8f8' },
  standup:   { Icon: Calendar,  color: '#c47a00', bg: '#fef3d6' },
  planning:  { Icon: Star,      color: '#5c6e00', bg: '#eef1d6' },
  interview: { Icon: Mic,       color: '#9c6a4a', bg: '#f5e8dc' },
  review:    { Icon: CheckCircle, color: '#2d7a60', bg: '#d4f0e8' },
};

const TAGS = Object.keys(SPACE_META);

// ── Space creator: icon + colour pickers ──────────────────────────────────────

const ICON_OPTIONS = [
  { name: 'Briefcase', Icon: Briefcase }, { name: 'Code',        Icon: Code        },
  { name: 'Coffee',    Icon: Coffee    }, { name: 'BookOpen',    Icon: BookOpen    },
  { name: 'Monitor',   Icon: Monitor   }, { name: 'FileText',    Icon: FileText    },
  { name: 'Pencil',    Icon: Pencil    }, { name: 'Layers',      Icon: Layers      },
  { name: 'Package',   Icon: Package   }, { name: 'Rocket',      Icon: Rocket      },
  { name: 'User',      Icon: User      }, { name: 'Users',       Icon: Users       },
  { name: 'Heart',     Icon: Heart     }, { name: 'Smile',       Icon: Smile       },
  { name: 'Award',     Icon: Award     }, { name: 'Star',        Icon: Star        },
  { name: 'Mail',      Icon: Mail      }, { name: 'Bell',        Icon: Bell        },
  { name: 'Phone',     Icon: Phone     }, { name: 'Video',       Icon: Video       },
  { name: 'MessageSquare', Icon: MessageSquare }, { name: 'Globe', Icon: Globe     },
  { name: 'Folder',    Icon: Folder    }, { name: 'Archive',     Icon: Archive     },
  { name: 'Bookmark',  Icon: Bookmark  }, { name: 'Hash',        Icon: Hash        },
  { name: 'Flag',      Icon: Flag      }, { name: 'Target',      Icon: Target      },
  { name: 'Zap',       Icon: Zap       }, { name: 'TrendingUp',  Icon: TrendingUp  },
  { name: 'MapPin',    Icon: MapPin    }, { name: 'Clock',       Icon: Clock       },
  { name: 'Calendar',  Icon: Calendar  }, { name: 'CheckCircle', Icon: CheckCircle },
  { name: 'Music',     Icon: Music     }, { name: 'Image',       Icon: Image       },
  { name: 'Flame',     Icon: Flame     }, { name: 'Leaf',        Icon: Leaf        },
  { name: 'Home',      Icon: Home      }, { name: 'Tag',         Icon: Tag         },
];

const COLOR_PRESETS = [
  { color: '#b45837', bg: '#f5e0d4' },
  { color: '#5c6e00', bg: '#eef1d6' },
  { color: '#1a4a5e', bg: '#d8eef5' },
  { color: '#4a3566', bg: '#e8dff5' },
  { color: '#c47a00', bg: '#fef3d6' },
  { color: '#2d5a27', bg: '#d8ebd5' },
  { color: '#c23b5a', bg: '#f8d8e0' },
  { color: '#0055aa', bg: '#d8e8f8' },
  { color: '#007a7a', bg: '#d4f0f0' },
  { color: '#664400', bg: '#f5e8d0' },
  { color: '#1a1814', bg: '#e8e4dc' },
  { color: '#6b3e26', bg: '#f0e4d8' },
];

// ── Meeting row ───────────────────────────────────────────────────────────────

function MeetingRow({ meeting, onOpen, onDelete, onRemoveTag, onToggleStar, isSelected }) {
  const hasAudio = !!meeting.has_recording || !!meeting.audio_path;
  const title    = cleanTitle(meeting.title);
  const isStarred = !!meeting.starred;
  const timeStr  = meeting.created_at ? (() => {
    const d = new Date(meeting.created_at);
    const time = format(d, 'HH:mm');
    if (isToday(d)) return time;
    if (isYesterday(d)) return `Yesterday ${time}`;
    return `${format(d, 'MMM d')} ${time}`;
  })() : '';
  const preview  = notePreview(meeting);

  const isRecording = meeting.status === 'recording';
  const isPaused    = meeting.status === 'paused';

  return (
    <div
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `meeting:${meeting.id}`);
      }}
      className={`group flex items-center gap-3.5 px-3 py-3 rounded-[12px] cursor-grab active:cursor-grabbing select-none transition-all ${
        isSelected ? 'bg-[#eef1d6] dark:bg-[#253015]' : 'hover:bg-white dark:hover:bg-[#333026] hover:shadow-[0_1px_4px_rgba(26,24,20,0.06)]'
      }`}
      onClick={() => onOpen(meeting.id)}
    >
      <div className="relative flex-shrink-0">
        <MeetingAvatar title={title} size={40} />
        {(isRecording || isPaused) && (
          <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${
            isRecording ? 'bg-[#b45837]' : 'bg-[#c47a00]'
          }`} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-[13.5px] font-medium text-[#1a1814] dark:text-[#e8e4db] truncate leading-tight block">
          {title}
        </span>
        {preview && (
          <span className="text-[11.5px] text-[#9c9285] dark:text-[#8a8278] mt-0.5 block truncate leading-tight">
            {preview}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        {hasAudio && <CassetteTape size={13} className="text-[#c0b9b0] dark:text-[#5e5850] mr-0.5" />}
        {timeStr && <span className="text-[12px] text-[#9c9285] dark:text-[#7a7268] tabular-nums group-hover:hidden mr-1">{timeStr}</span>}
        <button
          className={`flex items-center justify-center w-7 h-7 rounded-[8px] transition-all cursor-pointer ${
            isStarred
              ? 'opacity-100 text-[#c47a00] bg-[#fff3d6] dark:bg-[#3a2a10]'
              : 'opacity-0 group-hover:opacity-100 text-[#a09890] dark:text-[#6b6358] hover:bg-[#fff3d6] dark:hover:bg-[#3a2a10] hover:text-[#c47a00]'
          }`}
          onClick={(e) => { e.stopPropagation(); onToggleStar(meeting.id); }}
          aria-label={isStarred ? 'Unstar' : 'Star'}
          title={isStarred ? 'Remove star' : 'Star this note'}
        >
          <Star size={14} fill={isStarred ? 'currentColor' : 'none'} />
        </button>
        {onRemoveTag && (
          <button
            className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-7 h-7 rounded-[8px] hover:bg-[#fff0d6] dark:hover:bg-[#3a2a10] hover:text-[#c47a00] text-[#a09890] dark:text-[#6b6358] transition-all cursor-pointer"
            onClick={(e) => { e.stopPropagation(); onRemoveTag(meeting.id); }}
            aria-label="Remove from space"
            title="Remove from this space"
          >
            <Tag size={14} />
          </button>
        )}
        <button
          className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-7 h-7 rounded-[8px] hover:bg-[#f5e0d4] dark:hover:bg-[#3a1a10] hover:text-[#b45837] text-[#a09890] dark:text-[#6b6358] transition-all cursor-pointer"
          onClick={(e) => { e.stopPropagation(); onDelete(meeting.id); }}
          aria-label="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

// ── SpaceCreatorPopover ───────────────────────────────────────────────────────

function SpaceCreatorPopover({ onSave, onClose }) {
  const [name,     setName]     = useState('');
  const [iconName, setIconName] = useState('Star');
  const [colorIdx, setColorIdx] = useState(0);

  const preset  = COLOR_PRESETS[colorIdx];
  const IconCmp = ICON_OPTIONS.find((o) => o.name === iconName)?.Icon ?? Star;

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({ id: Date.now().toString(), name: name.trim().toLowerCase(), icon: iconName, color: preset.color, bg: preset.bg });
  };

  return (
    <div className="mx-2 mt-1.5 mb-1 p-3 rounded-[12px] animate-fade-in" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: '0 4px 16px rgba(0,0,0,0.18)' }}>

      {/* Preview + name row */}
      <div className="flex items-center gap-2.5 mb-3">
        <span
          className="flex items-center justify-center rounded-[8px] flex-shrink-0"
          style={{ width: 28, height: 28, background: preset.bg }}
        >
          <IconCmp size={14} color={preset.color} />
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
          placeholder="Space name…"
          className="flex-1 text-[13px] text-[#1a1814] placeholder:text-[#c4bdb5] bg-transparent outline-none border-b border-[#e2ddd4] pb-0.5 focus:border-[#5c6e00] transition-colors"
        />
      </div>

      {/* Colour swatches */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {COLOR_PRESETS.map((p, i) => (
          <button
            key={i}
            onClick={() => setColorIdx(i)}
            title={p.color}
            className="transition-transform hover:scale-110"
            style={{
              width: 18, height: 18, borderRadius: '50%',
              background: p.color, flexShrink: 0,
              outline: colorIdx === i ? `2px solid ${p.color}` : 'none',
              outlineOffset: 2,
            }}
          />
        ))}
      </div>

      {/* Icon grid */}
      <div className="grid gap-0.5 mb-3" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
        {ICON_OPTIONS.map(({ name: n, Icon }) => (
          <button
            key={n}
            onClick={() => setIconName(n)}
            title={n}
            className="flex items-center justify-center rounded-[6px] transition-all"
            style={{
              width: 26, height: 26,
              background: iconName === n ? preset.bg : 'transparent',
              color:      iconName === n ? preset.color : 'var(--ink-faint)',
            }}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onClose}
          className="flex-1 py-1.5 rounded-[8px] text-[12px] text-[#5c5448] hover:bg-[#f5f2e9] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim()}
          className="flex-1 py-1.5 rounded-[8px] text-[12px] font-medium text-white transition-colors disabled:opacity-40"
          style={{ background: preset.color }}
        >
          Create
        </button>
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ meetings, activeTag, setActiveTag, searchQuery, setSearchQuery, globalTodos, onNewMeeting, onTagDrop, refresh }) {
  const [spacesOpen,   setSpacesOpen]   = useState(true);
  const [dropTarget,   setDropTarget]   = useState(null);
  const [reorderOver,  setReorderOver]  = useState(null);
  const [showCreator,  setShowCreator]  = useState(false);
  // customSpaces: start from localStorage for immediate render, then sync with DB
  const [customSpaces, setCustomSpaces] = useState(() => {
    try { return JSON.parse(localStorage.getItem('steno:customSpaces') || '[]'); }
    catch { return []; }
  });
  const [spaceOrder, setSpaceOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('steno:spaceOrder') || 'null');
      if (Array.isArray(saved)) return saved;
    } catch {}
    return [...TAGS];
  });
  const draggingSpaceRef = useRef(null);
  const spaceOrderRef    = useRef(spaceOrder);
  useEffect(() => { spaceOrderRef.current = spaceOrder; }, [spaceOrder]);

  // On mount, load spaces from DB and merge — don't overwrite any user edits made
  // since the component mounted (e.g. created but not yet saved). [W14]
  useEffect(() => {
    window.api?.db?.getSpaces?.().then((rows) => {
      if (!rows?.length) return;
      const loaded = rows.map((r) => ({ name: r.name, icon: r.icon, color: r.color, bg: r.bg }));
      const order  = rows.map((r) => r.name);
      setCustomSpaces((prev) => {
        // Add DB spaces not already present; preserve locally-created entries
        const prevNames = new Set(prev.map((s) => s.name));
        const toAdd = loaded.filter((s) => !prevNames.has(s.name));
        return toAdd.length ? [...prev, ...toAdd] : prev;
      });
      // Merge DB order with current order, appending new DB entries at the end
      const fullOrder = [
        ...spaceOrderRef.current,
        ...order.filter((n) => !spaceOrderRef.current.includes(n)),
      ];
      setSpaceOrder(fullOrder);
      spaceOrderRef.current = fullOrder;
      localStorage.setItem('steno:spaceOrder', JSON.stringify(fullOrder));
    }).catch(() => {});
  }, []);

  // Persist custom spaces to DB + localStorage whenever they change
  const persistSpaces = (spaces, order) => {
    // Derive the ordered list of custom spaces for DB storage
    const customInOrder = order
      .filter((n) => spaces.some((s) => s.name === n))
      .map((n, i) => ({ ...spaces.find((s) => s.name === n), sort_order: i }));
    window.api?.db?.saveSpaces?.(customInOrder).catch(() => {});
    localStorage.setItem('steno:customSpaces', JSON.stringify(spaces));
    localStorage.setItem('steno:spaceOrder', JSON.stringify(order));
  };

  const saveOrder = (order) => {
    spaceOrderRef.current = order;
    setSpaceOrder(order);
    persistSpaces(customSpaces, order);
  };

  const handleCreateSpace = (space) => {
    // Reject names that collide with built-in tags or existing custom spaces
    const existingNames = [...TAGS, ...customSpaces.map((s) => s.name)];
    if (existingNames.includes(space.name)) {
      alert(`A space named "${space.name}" already exists.`);
      return;
    }
    const updated   = [...customSpaces, space];
    const newOrder  = [...spaceOrderRef.current, space.name];
    setCustomSpaces(updated);
    persistSpaces(updated, newOrder);
    spaceOrderRef.current = newOrder;
    setSpaceOrder(newOrder);
    setShowCreator(false);
    setActiveTag(space.name);
  };

  const handleDeleteSpace = async (name) => {
    const updatedSpaces = customSpaces.filter((s) => s.name !== name);
    const updatedOrder  = spaceOrderRef.current.filter((n) => n !== name);
    setCustomSpaces(updatedSpaces);
    persistSpaces(updatedSpaces, updatedOrder);
    spaceOrderRef.current = updatedOrder;
    setSpaceOrder(updatedOrder);
    if (activeTag === name) setActiveTag(null);

    // Strip the deleted space's tag from all meetings that have it
    const affected = meetings.filter((m) => {
      try { return JSON.parse(m.tags || '[]').includes(name); } catch { return false; }
    });
    if (affected.length > 0) {
      await Promise.all(affected.map((m) => {
        const tags = (() => { try { return JSON.parse(m.tags || '[]'); } catch { return []; } })();
        return window.api.db.updateMeeting(m.id, { tags: JSON.stringify(tags.filter((t) => t !== name)) });
      }));
      refresh?.();
    }
  };

  const handleSpaceReorder = (fromName, toName) => {
    const order = [...spaceOrderRef.current];
    // if either name isn't tracked yet, add it before reordering
    if (!order.includes(fromName)) order.push(fromName);
    if (!order.includes(toName))   order.push(toName);
    const fromIdx = order.indexOf(fromName);
    const toIdx   = order.indexOf(toName);
    if (fromIdx === toIdx) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, fromName);
    saveOrder(order);
  };

  // Build allSpaces in current order, inserting any new custom spaces not yet in order
  const spaceMetaMap = Object.fromEntries([
    ...TAGS.map((tag) => [tag, { name: tag, ...SPACE_META[tag] }]),
    ...customSpaces.map((s) => {
      const Icon = ICON_OPTIONS.find((o) => o.name === s.icon)?.Icon ?? Star;
      return [s.name, { name: s.name, Icon, color: s.color, bg: s.bg }];
    }),
  ]);

  const orderedNames = [
    ...spaceOrder.filter((n) => spaceMetaMap[n]),
    ...Object.keys(spaceMetaMap).filter((n) => !spaceOrder.includes(n)),
  ];
  const allSpaces = orderedNames.map((n) => spaceMetaMap[n]);
  return (
    <div className="flex flex-col h-full bg-[#f2f0eb] dark:bg-[#1c1a12] border-r border-[#e2ddd4] dark:border-[#524c3e]" style={{ width: 232 }}>

      {/* Logo — fills the traffic-light zone, buttons overlay on top */}
      <div style={{ height: 52 }} className="titlebar-drag flex-shrink-0 flex items-center justify-center px-3">
        <img
          src="/logo.png"
          alt="Stenographer"
          draggable={false}
          className="no-drag"
          style={{ height: '100%', width: 'auto', opacity: 0.9 }}
        />
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <div className="relative">
          <Search size={13} className="absolute top-1/2 -translate-y-1/2 text-[#b0a898]" style={{ left: 10 }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search"
            style={{ paddingLeft: 30 }}
            className="w-full pr-10 py-1.5 bg-white/80 dark:bg-[#333026] border border-[#d8d4cc] dark:border-[#524c3e] rounded-[9px] text-[12.5px] text-[#1a1814] dark:text-[#e8e4db] placeholder:text-[#b0a898] dark:placeholder:text-[#5e5850] outline-none focus:border-[#5c6e00] focus:bg-white dark:focus:bg-[#2c2820] transition-all shadow-[0_1px_3px_rgba(26,24,20,0.06)]"
          />
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {searchQuery ? (
              <button onClick={() => setSearchQuery('')} className="text-[#b0a898] cursor-pointer hover:text-[#5c5448]">
                <X size={11} />
              </button>
            ) : (
              <kbd className="text-[10px] text-[#b0a898] dark:text-[#6b6358] font-medium bg-[#ede9df] dark:bg-[#3d3930] px-1 py-0.5 rounded-[4px] leading-none">⌘K</kbd>
            )}
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="px-2 space-y-0.5 flex-shrink-0">
        <button
          onClick={() => setActiveTag(null)}
          className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-[13px] transition-all cursor-pointer text-left ${
            !activeTag
              ? 'bg-white dark:bg-[#3d3930] text-[#1a1814] dark:text-[#e8e4db] font-medium shadow-[0_1px_3px_rgba(26,24,20,0.08)]'
              : 'text-[#5c5448] dark:text-[#a09890] hover:bg-white/60 dark:hover:bg-[#333026]'
          }`}
        >
          <Home size={14} className={!activeTag ? 'text-[#1a1814] dark:text-[#e8e4db]' : 'text-[#9c9285] dark:text-[#6b6358]'} />
          All Notes
          <span className="ml-auto text-[10.5px] text-[#9c9285] dark:text-[#7a7268] tabular-nums">{meetings.length}</span>
        </button>
      </nav>

      {/* Spaces */}
      <div className="mt-5 px-2 flex-shrink-0">
        <button
          onClick={() => setSpacesOpen((o) => !o)}
          className="flex items-center gap-1.5 w-full px-2.5 py-1 text-[10.5px] font-semibold text-[#9c9285] dark:text-[#7a7268] uppercase tracking-widest cursor-pointer hover:text-[#5c5448] dark:hover:text-[#a09890] transition-colors"
        >
          {spacesOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          Spaces
        </button>

        {spacesOpen && (
          <div className="mt-1 space-y-0.5">
            {allSpaces.map(({ name: tag, Icon, color, bg }) => {
              const count        = meetings.filter((m) => {
                try { return JSON.parse(m.tags || '[]').includes(tag); } catch { return false; }
              }).length;
              const isActive        = activeTag === tag;
              const isTagDrop       = dropTarget === tag;
              const isReorderTarget = reorderOver === tag;
              const isCustom        = customSpaces.some((s) => s.name === tag);

              return (
                <div
                  key={tag}
                  draggable={true}
                  onDragStart={(e) => {
                    draggingSpaceRef.current = tag;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', `space:${tag}`);
                  }}
                  onDragEnd={() => {
                    draggingSpaceRef.current = null;
                    setReorderOver(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (draggingSpaceRef.current && draggingSpaceRef.current !== tag) {
                      setReorderOver(tag);
                      setDropTarget(null);
                    } else if (!draggingSpaceRef.current) {
                      e.dataTransfer.dropEffect = 'move';
                      setDropTarget(tag);
                    }
                  }}
                  onDragEnter={(e) => { e.preventDefault(); }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) {
                      setDropTarget(null);
                      setReorderOver(null);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const raw = e.dataTransfer.getData('text/plain');
                    setDropTarget(null);
                    setReorderOver(null);
                    if (draggingSpaceRef.current && draggingSpaceRef.current !== tag) {
                      handleSpaceReorder(draggingSpaceRef.current, tag);
                      draggingSpaceRef.current = null;
                    } else if (raw?.startsWith('meeting:')) {
                      onTagDrop(raw.slice(8), tag);
                    }
                  }}
                  className={`relative group/space select-none transition-all ${isReorderTarget ? 'opacity-50' : ''}`}
                  style={isReorderTarget ? { boxShadow: `inset 0 -2px 0 ${color}` } : {}}
                >
                  <button
                    onClick={() => setActiveTag(isActive ? null : tag)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-[12.5px] transition-all cursor-grab active:cursor-grabbing text-left ${
                      isTagDrop
                        ? 'scale-[1.02] rounded-[10px]'
                        : isActive
                        ? 'bg-white dark:bg-[#3d3930] text-[#1a1814] dark:text-[#e8e4db] font-medium shadow-[-1px_1px_4px_rgba(26,24,20,0.08)] rounded-l-[10px]'
                        : 'text-[#5c5448] dark:text-[#a09890] hover:bg-white/60 dark:hover:bg-[#333026] rounded-[10px]'
                    }`}
                    style={isTagDrop ? { background: bg, boxShadow: `0 0 0 2px ${color}` } : isActive ? { paddingRight: 10, marginRight: -8 } : {}}
                  >
                    <span
                      className="flex items-center justify-center rounded-[6px] flex-shrink-0"
                      style={{ width: 20, height: 20, background: isActive || isTagDrop ? color : bg }}
                    >
                      <Icon size={11} color={isActive || isTagDrop ? '#fff' : color} />
                    </span>
                    <span className="capitalize flex-1">{tag}</span>
                    {count > 0 && !isCustom && (
                      <span className="text-[10.5px] text-[#9c9285] dark:text-[#7a7268] tabular-nums">{count}</span>
                    )}
                    {isCustom ? (
                      <>
                        {count > 0 && (
                          <span className="text-[10.5px] text-[#9c9285] dark:text-[#7a7268] tabular-nums group-hover/space:hidden">{count}</span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteSpace(tag); }}
                          className="opacity-0 group-hover/space:opacity-100 p-0.5 rounded-[4px] hover:bg-[#f5e0d4] dark:hover:bg-[#3a1a10] hover:text-[#b45837] text-[#c0b9b0] dark:text-[#6b6358] transition-all flex-shrink-0"
                          title="Delete space"
                        >
                          <X size={11} />
                        </button>
                      </>
                    ) : (
                      <GripVertical size={10} className="opacity-0 group-hover/space:opacity-30 text-[#9c9285] dark:text-[#6b6358] flex-shrink-0" />
                    )}
                  </button>
                </div>
              );
            })}

            {/* New space button / creator */}
            {showCreator ? (
              <SpaceCreatorPopover onSave={handleCreateSpace} onClose={() => setShowCreator(false)} />
            ) : (
              <button
                onClick={() => setShowCreator(true)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[10px] text-[11.5px] text-[#b0a898] dark:text-[#7a7268] hover:text-[#5c5448] dark:hover:text-[#a09890] hover:bg-white/60 dark:hover:bg-[#333026] transition-all cursor-pointer"
              >
                <Plus size={11} />
                New space
              </button>
            )}
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom: action icons + app identity */}
      <div className="border-t border-[#e2ddd4] px-3 pt-2.5 pb-3.5">
        {/* Action icons row */}
        <div className="flex items-center gap-1 px-0.5">
          {activeTag && (
            <button
              onClick={() => setActiveTag(null)}
              title="Clear tag filter"
              className="p-1.5 rounded-[7px] text-[#5c6e00] hover:text-[#3d4900] hover:bg-white/70 transition-all cursor-pointer"
            >
              <Tag size={13} />
            </button>
          )}
        </div>

      </div>
    </div>
  );
}

// ── Search results ─────────────────────────────────────────────────────────────

function SearchResults({ results, onOpen }) {
  if (!results.length) return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Search size={22} className="text-[#c0b9b0] mb-2" />
      <p className="text-sm text-[#9c9285]">No results</p>
    </div>
  );

  return (
    <div className="py-3 space-y-1">
      <p className="text-[11px] font-semibold text-[#9c9285] uppercase tracking-wider mb-3 px-1">
        {results.length} result{results.length !== 1 ? 's' : ''}
      </p>
      {results.map((r) => (
        <div
          key={r.meeting_id}
          className="flex items-center gap-3 px-3 py-2.5 rounded-[12px] cursor-pointer hover:bg-white hover:shadow-[0_1px_4px_rgba(26,24,20,0.06)] transition-all"
          onClick={() => onOpen(r.meeting_id)}
        >
          <MeetingAvatar title={r.title || '?'} size={38} />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-[#1a1814] truncate">{r.title}</p>
            {r.notes_snippet && (
              <p
                className="text-[11px] text-[#9c9285] truncate"
                // Strip all tags except <mark>…</mark> to prevent XSS from FTS snippets. [W11]
                dangerouslySetInnerHTML={{
                  __html: r.notes_snippet
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/&lt;mark&gt;/g, '<mark>')
                    .replace(/&lt;\/mark&gt;/g, '</mark>'),
                }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Library view ──────────────────────────────────────────────────────────────

export function Library() {
  const { meetings, globalTodos, searchQuery, searchResults, setSearchQuery, setSearchResults } = useAppStore();
  const { refresh, createMeeting, deleteMeeting } = useMeetings();
  const setActiveMeeting        = useAppStore((s) => s.setActiveMeeting);
  const setPendingImportFile    = useAppStore((s) => s.setPendingImportFile);
  const [activeTag, setActiveTag]     = useState(null);
  const [selectedId, setSelectedId]   = useState(null);
  const [settingsOpen, setSettings]   = useState(false);
  const [isDragOver, setIsDragOver]   = useState(false);
  const fileInputRef                  = useRef(null);
  const searchDebounceRef             = useRef(null);
  const searchSeqRef                  = useRef(0);

  useEffect(() => { refresh(); }, []);

  // Clear pending search debounce on unmount to avoid calling setState on an
  // unmounted component (e.g. navigating away mid-search). [W12]
  useEffect(() => {
    return () => { clearTimeout(searchDebounceRef.current); };
  }, []);

  const handleSearch = useCallback((q) => {
    setSearchQuery(q);
    clearTimeout(searchDebounceRef.current);

    if (!q.trim()) {
      ++searchSeqRef.current; // invalidate any in-flight debounced search
      setSearchResults([]);
      return;
    }

    searchDebounceRef.current = setTimeout(async () => {
      // Stale-result guard: each search invocation gets a sequence number.
      // If a newer search started while this one was awaiting, discard results.
      const seq = ++searchSeqRef.current;

      const lower = q.toLowerCase();

      // Always run FTS so transcript-only matches are included; FTS covers
      // title + notes + transcript. Fall back to client-side filter if FTS throws.
      // Sanitize the query to prevent FTS5 syntax errors on special characters
      // (e.g. C++, "quoted", (parens)) by quoting each term individually.
      const sanitizedFts = q.trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"*`)
        .join(' ');

      let dbResults = [];
      try {
        dbResults = (await window.api.db.search(sanitizedFts)) ?? [];
      } catch {
        // FTS failed; fall through to client-only results
      }

      if (seq !== searchSeqRef.current) return; // superseded

      // Merge client-side matches (title/notes in loaded list) with FTS results,
      // deduped by meeting_id. FTS results take precedence for snippet text.
      const clientMatches = meetings
        .filter((m) => {
          const title = (m.title || '').toLowerCase();
          const notes = (m.human_doc_text || '').toLowerCase();
          return title.includes(lower) || notes.includes(lower);
        })
        .map((m) => ({ meeting_id: m.id, title: m.title, created_at: m.created_at, notes_snippet: null }));

      const seen = new Set(dbResults.map((r) => r.meeting_id));
      const merged = [
        ...dbResults,
        ...clientMatches.filter((m) => !seen.has(m.meeting_id)),
      ];

      setSearchResults(merged);
    }, 200);
  }, [setSearchQuery, setSearchResults, meetings]);

  const handleNewMeeting = async () => {
    const meeting = await createMeeting({ title: NEW_NOTE_TITLE });
    if (meeting) setActiveMeeting(meeting.id);
  };

  const AUDIO_EXTS = /\.(wav|mp3|m4a|aac|flac|ogg|webm|mp4)$/i;

  const handleImportFile = useCallback(async (file) => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !AUDIO_EXTS.test(file.name)) return;
    const title = file.name.replace(/\.[^.]+$/, '');
    // Create meeting first so we know which meeting the import belongs to.
    // The pending file is handled by Workspace; if transcription fails, Workspace
    // updates status to 'error' and the orphan meeting stays visible (user can retry).
    // If the meeting was never navigated to, it will be cleaned up by isBlank on Back. [W15]
    const meeting = await createMeeting({ title });
    if (!meeting) return;
    setPendingImportFile(file);
    setActiveMeeting(meeting.id);
  }, [createMeeting, setActiveMeeting, setPendingImportFile]);

  // Listen for File > Import Audio… menu trigger
  useEffect(() => {
    window.api?.onTriggerFileImport?.(() => fileInputRef.current?.click());
    return () => window.api?.offTriggerFileImport?.();
  }, []);

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this meeting and all its data?')) return;
    await deleteMeeting(id);
  };

  const handleOpen = (id) => {
    setSelectedId(id);
    setActiveMeeting(id);
  };

  const handleTagDrop = useCallback(async (meetingId, tag) => {
    const meeting = meetings.find((m) => m.id === meetingId);
    if (!meeting) return;
    const existing = (() => { try { return JSON.parse(meeting.tags || '[]'); } catch { return []; } })();
    if (existing.includes(tag)) return;
    await window.api.db.updateMeeting(meetingId, { tags: JSON.stringify([...existing, tag]) });
    refresh();
  }, [meetings, refresh]);

  const handleRemoveTag = useCallback(async (meetingId, tag) => {
    const meeting = meetings.find((m) => m.id === meetingId);
    if (!meeting) return;
    const existing = (() => { try { return JSON.parse(meeting.tags || '[]'); } catch { return []; } })();
    await window.api.db.updateMeeting(meetingId, { tags: JSON.stringify(existing.filter((t) => t !== tag)) });
    refresh();
  }, [meetings, refresh]);

  const handleToggleStar = useCallback(async (id) => {
    await window.api.db.toggleStar(id);
    refresh();
  }, [refresh]);

  const isSearching      = searchQuery.trim().length > 0;
  const filteredMeetings = activeTag
    ? meetings.filter((m) => {
        try { return JSON.parse(m.tags || '[]').includes(activeTag); } catch { return false; }
      })
    : meetings;

  const groups = groupMeetingsByDate(filteredMeetings);

  return (
    <div
      className="flex h-full relative"
      style={{ background: 'var(--bg-page)' }}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) handleImportFile(file);
      }}
    >
      {/* Hidden file input for button + menu trigger */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.webm,.mp4"
        style={{ display: 'none' }}
        onChange={(e) => { handleImportFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {/* Drag-over overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center pointer-events-none"
          style={{ background: 'rgba(92,110,0,0.08)', border: '2px dashed #5c6e00', borderRadius: 12 }}>
          <Upload size={28} className="text-[#5c6e00] mb-2" />
          <p className="text-[14px] font-semibold text-[#5c6e00]">Drop audio file to import</p>
        </div>
      )}

      {/* ── Left sidebar ── */}
      <div className="flex-shrink-0" style={{ width: 232 }}>
        <div className="h-full">
          <Sidebar
            meetings={meetings}
            activeTag={activeTag}
            setActiveTag={setActiveTag}
            searchQuery={searchQuery}
            setSearchQuery={handleSearch}
            globalTodos={globalTodos}
            onNewMeeting={handleNewMeeting}
            onTagDrop={handleTagDrop}
            refresh={refresh}
          />
        </div>
      </div>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettings(false)} />

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">

        {/* Header (titlebar drag region) */}
        <div
          className="flex items-end justify-between pb-4 titlebar-drag flex-shrink-0"
          style={{ paddingTop: 38, paddingLeft: 32, paddingRight: 20 }}
        >
          <h1 className="text-[30px] font-bold text-[#1a1814] dark:text-[#e8e4db] tracking-[-0.04em] leading-none no-drag">
            {activeTag ? <span className="capitalize">{activeTag}</span> : 'Notes'}
          </h1>
          <div className="no-drag flex items-center gap-2 pb-0.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: '8px 16px', fontSize: 13, fontWeight: 500, borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--ink-faint)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', transition: 'background 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-surface2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
              title="Import an audio file to transcribe (⌘O)"
            >
              <Upload size={13} /> Import
            </button>
            <button
              onClick={async () => {
                const meeting = await createMeeting({ title: NEW_NOTE_TITLE });
                if (meeting) setActiveMeeting(meeting.id);
              }}
              style={{ padding: '8px 20px', fontSize: 13, fontWeight: 500, borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--ink)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, boxShadow: '0 1px 4px rgba(0,0,0,0.10)', transition: 'background 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-surface2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            >
              <Plus size={14} /> New note
            </button>
            <button
              onClick={() => setSettings(true)}
              className="btn-icon no-drag"
              title="Settings"
            >
              <Settings size={15} />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col items-center">
          <div className="w-full max-w-[720px] px-8 pb-4">
            {isSearching ? (
              <SearchResults results={searchResults} onOpen={handleOpen} />
            ) : filteredMeetings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="w-16 h-16 rounded-2xl bg-white dark:bg-[#333026] border border-[#e5e1d8] dark:border-[#524c3e] flex items-center justify-center mb-5 shadow-[0_2px_8px_rgba(26,24,20,0.06)]">
                  <Mic size={26} className="text-[#9c9285] dark:text-[#6b6358]" />
                </div>
                <h2 className="text-[16px] font-semibold text-[#1a1814] dark:text-[#e8e4db] mb-2">
                  {activeTag ? `No "${activeTag}" notes yet` : 'No notes yet'}
                </h2>
                <p className="text-[13px] text-[#9c9285] dark:text-[#6b6358] max-w-[200px] leading-relaxed">
                  Create a new note to get started
                </p>
              </div>
            ) : (
              <div className="pt-3 space-y-8">
                {groups.map(({ label, items }) => (
                  <section key={label}>
                    <h2 className="text-[10.5px] font-bold text-[#9c9285] dark:text-[#7a7268] uppercase tracking-[0.1em] px-1 mb-2.5">
                      {label}
                    </h2>
                    <div className="space-y-2.5">
                      {items.map((m) => (
                        <MeetingRow
                          key={m.id}
                          meeting={m}
                          onOpen={handleOpen}
                          onDelete={handleDelete}
                          onRemoveTag={activeTag ? (id) => handleRemoveTag(id, activeTag) : undefined}
                          onToggleStar={handleToggleStar}
                          isSelected={selectedId === m.id}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
