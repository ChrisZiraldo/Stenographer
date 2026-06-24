import { useEffect, useRef, useState } from 'react';
import { FileText, Zap, Loader, Copy, Trash2, Search, X } from 'lucide-react';
import { useAppStore } from '../store/appStore.js';

function TabButton({ active, onClick, icon: Icon, label, badge }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '8px 12px',
        fontSize: 13, fontWeight: active ? 600 : 500,
        color: active ? 'var(--ink)' : 'var(--ink-faint)',
        background: active ? 'var(--bg-surface)' : 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid #5c6e00' : '2px solid transparent',
        cursor: 'pointer',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--ink-muted)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--ink-faint)'; }}
    >
      <Icon size={13} />
      {label}
      {badge && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#5c6e00', flexShrink: 0 }} />}
    </button>
  );
}

// ── Summary panel ──────────────────────────────────────────────────────────────

function SummaryPanel({ summary, summaryState }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [summary]);

  if (!summary && !summaryState) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-7">
        <div className="w-10 h-10 rounded-2xl bg-[#f5e27e]/40 flex items-center justify-center mb-3">
          <Zap size={18} className="text-[#9c7c00]" />
        </div>
        <p className="text-sm font-medium text-[#5c5448] dark:text-[#a09890] mb-1">Live Summary</p>
        <p className="text-[12px] text-[#9c9285] dark:text-[#6b6358] leading-relaxed">
          AI updates this as your meeting progresses. Enable Live Summary in settings.
        </p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
      {summaryState && (
        <div className="flex items-center gap-1.5 text-[11px] text-[#9c9285] dark:text-[#6b6358] mb-3 italic">
          <Loader size={11} className="animate-spin text-[#5c6e00]" />
          {summaryState}
        </div>
      )}
      {summary && (
        <div className="space-y-1.5">
          {summary.split('\n').map((line, i) => {
            if (line.startsWith('- ')) return (
              <div key={i} className="flex gap-2.5 items-start">
                <span className="text-[#5c6e00] flex-shrink-0 mt-[3px] text-[10px] font-bold">•</span>
                <span className="text-[13px] text-[#1a1814] dark:text-[#e8e4db] leading-relaxed">{line.slice(2)}</span>
              </div>
            );
            return line.trim()
              ? <p key={i} className="text-[13px] text-[#5c5448] dark:text-[#a09890] leading-relaxed">{line}</p>
              : <div key={i} className="h-1" />;
          })}
        </div>
      )}
    </div>
  );
}

// ── Transcript panel ───────────────────────────────────────────────────────────

function TranscriptPanel({ segments, audioRef, isRecording, onRemoveSegment }) {
  const scrollRef   = useRef(null);
  const [query, setQuery]       = useState('');
  const [copyAllDone, setCopyAllDone] = useState(false);

  useEffect(() => {
    if (scrollRef.current && !query) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segments, query]);

  const handleSegmentClick = (seg) => {
    // seg.startMs may be 0 (valid), so use != null rather than falsy check
    if (!audioRef?.current || seg.startMs == null) return;
    audioRef.current.currentTime = seg.startMs / 1000;
    audioRef.current.play().catch(() => {});
  };

  const handleCopyAll = () => {
    const text = segments.map((s) => s.text ?? '').join('\n');
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopyAllDone(true);
    setTimeout(() => setCopyAllDone(false), 2000);
  };

  const handleCopyChunk = (e, text) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text ?? '');
  };

  const filtered = query.trim()
    ? segments.filter((s) => (s.text ?? '').toLowerCase().includes(query.toLowerCase()))
    : segments;

  if (!segments.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-7">
        <div className="w-10 h-10 rounded-2xl bg-[#f5f2e9] dark:bg-[#333026] flex items-center justify-center mb-3">
          {isRecording
            ? <Loader size={18} className="text-[#5c6e00] animate-spin" />
            : <FileText size={18} className="text-[#9c9285]" />
          }
        </div>
        <p className="text-sm font-medium text-[#5c5448] mb-1">
          {isRecording ? 'Listening…' : 'Live Transcript'}
        </p>
        <p className="text-[12px] text-[#9c9285] leading-relaxed">
          {isRecording
            ? 'Transcribed speech will appear here.'
            : 'Transcribed speech appears here in real time.'
          }
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#e8e4da] flex-shrink-0">
        {/* Search input */}
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#b0a898] pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transcript…"
            className="w-full pl-7 pr-6 py-1.5 bg-[#f0ede6] dark:bg-[#333026] border border-transparent focus:border-[#ddd9cf] dark:focus:border-[#524c3e] rounded-[8px] text-[12px] text-[#1a1814] dark:text-[#e8e4db] placeholder:text-[#b0a898] dark:placeholder:text-[#5e5850] outline-none transition-all"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#b0a898] hover:text-[#5c5448] cursor-pointer"
            >
              <X size={11} />
            </button>
          )}
        </div>
        {/* Copy all */}
        <button
          onClick={handleCopyAll}
          title="Copy all"
          className="btn-icon flex-shrink-0"
          style={{ width: 28, height: 28 }}
        >
          {copyAllDone ? (
            <span className="text-[10px] text-[#5c6e00] font-semibold">✓</span>
          ) : (
            <Copy size={13} />
          )}
        </button>
      </div>

      {/* Segment list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 min-h-0 space-y-1">
        {filtered.length === 0 && query && (
          <p className="text-[12px] text-[#9c9285] text-center py-8">No results for "{query}"</p>
        )}
        {filtered.map((seg) => (
          <div
            key={seg.id}
            onClick={() => handleSegmentClick(seg)}
            className={`animate-fade-in group relative rounded-[9px] py-2 px-2.5 -mx-0.5 ${seg.startMs != null ? 'hover:bg-[#f5f2e9] dark:hover:bg-[#333026] cursor-pointer' : ''}`} /* [C8] */
          >
            {seg.speaker && (
              <div className="text-[10px] font-semibold text-[#5c6e00] uppercase tracking-wide mb-0.5">{seg.speaker}</div>
            )}
            <p className="text-[13px] text-[#2a2620] dark:text-[#c8c4bb] leading-relaxed pr-14">{seg.text}</p>
            {seg.startMs != null && ( /* [C8] */
              <span className="text-[10px] text-[#c4bdb5] dark:text-[#5e5850] group-hover:text-[#9c9285] dark:group-hover:text-[#6b6358] transition-colors">
                {(seg.startMs / 1000).toFixed(1)}s
              </span>
            )}
            {/* Per-chunk actions */}
            <div className="absolute top-2 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={(e) => handleCopyChunk(e, seg.text)}
                className="btn-icon"
                style={{ width: 24, height: 24, borderRadius: 6 }}
                title="Copy"
              >
                <Copy size={11} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onRemoveSegment(seg.id); }}
                className="btn-icon hover:!bg-[#f5e0d4] hover:!text-[#b45837]"
                style={{ width: 24, height: 24, borderRadius: 6 }}
                title="Delete"
              >
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── RightPane ─────────────────────────────────────────────────────────────────

export function RightPane({ audioRef }) {
  // Use per-slice selectors to avoid re-rendering on every audioLevel/liveTranscript
  // update that this component doesn't consume. [C10]
  const rightTab         = useAppStore((s) => s.rightTab);
  const setRightTab      = useAppStore((s) => s.setRightTab);
  const liveSegments     = useAppStore((s) => s.liveSegments);
  const liveSummary      = useAppStore((s) => s.liveSummary);
  const summaryState     = useAppStore((s) => s.summaryState);
  const recordingStatus  = useAppStore((s) => s.recordingStatus);
  const removeLiveSegment = useAppStore((s) => s.removeLiveSegment);
  const liveTxEnabled    = useAppStore((s) => s.liveTxEnabled);
  const liveSummaryEnabled = useAppStore((s) => s.liveSummaryEnabled);

  // Keep active tab valid when settings change
  useEffect(() => {
    if (rightTab === 'summary' && !liveSummaryEnabled && liveTxEnabled) setRightTab('transcript');
    if (rightTab === 'transcript' && !liveTxEnabled && liveSummaryEnabled) setRightTab('summary');
  }, [liveSummaryEnabled, liveTxEnabled]);

  // Auto-switch to Summary tab when first summary chunk arrives
  const prevSummary = useRef('');
  useEffect(() => {
    if (liveSummary && !prevSummary.current && rightTab === 'transcript') {
      setRightTab('summary');
    }
    prevSummary.current = liveSummary;
  }, [liveSummary]);

  const isRecording = recordingStatus === 'recording';
  const showTabs = liveSummaryEnabled && liveTxEnabled;

  return (
    <div className="flex flex-col h-full bg-[#f5f2e9] dark:bg-[#2a261c] border-l border-[#ddd9cf] dark:border-[#46412e]">
      {/* Tab bar */}
      <div style={{ display: 'flex', background: 'var(--bg-surface3)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {showTabs ? (
          <>
            <TabButton active={rightTab === 'summary'}    onClick={() => setRightTab('summary')}    icon={Zap}      label="Summary"    badge={isRecording && !!liveSummary} />
            <TabButton active={rightTab === 'transcript'} onClick={() => setRightTab('transcript')} icon={FileText} label="Transcript" badge={isRecording && liveSegments.length > 0} />
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', fontSize: 13, fontWeight: 600, color: 'var(--ink)', borderBottom: '2px solid #5c6e00' }}>
            {liveSummaryEnabled ? <><Zap size={13} color="#9c7c00" /> Summary</> : <><FileText size={13} color="var(--ink-faint)" /> Transcript</>}
          </div>
        )}
      </div>

      {/* Panel */}
      <div className="flex-1 flex flex-col min-h-0">
        {(liveSummaryEnabled && (!liveTxEnabled || rightTab === 'summary')) && (
          <SummaryPanel summary={liveSummary} summaryState={summaryState} />
        )}
        {(liveTxEnabled && (!liveSummaryEnabled || rightTab === 'transcript')) && (
          <TranscriptPanel
            segments={liveSegments}
            audioRef={audioRef}
            isRecording={isRecording}
            onRemoveSegment={removeLiveSegment}
          />
        )}
      </div>

      <audio ref={audioRef} className="hidden" />
    </div>
  );
}
