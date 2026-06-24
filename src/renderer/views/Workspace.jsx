import { useEffect, useState, useRef, useCallback } from 'react';
import {
  ArrowLeft, Mic, MicOff, Settings, Sparkles,
  Loader, Download, Plus, X as XIcon
} from 'lucide-react';
import { useAppStore } from '../store/appStore.js';
import { recorder } from '../engine/recorder.js';
import { NotesEditor } from '../components/NotesEditor.jsx';
import { RightPane } from '../components/RightPane.jsx';
import { AudioBars } from '../components/AudioBars.jsx';
import { SettingsDrawer } from '../components/SettingsDrawer.jsx';
import { Button } from '../components/ui/Button.jsx';
import {
  Briefcase, User, Users, Calendar, Star, Mic as MicIcon, CheckCircle,
  Code, Coffee, BookOpen, Heart, Smile, Award, Mail, Bell, Globe,
  Folder, Archive, Bookmark, Hash, Flag, Target, Zap as ZapIcon,
  TrendingUp, MapPin, Clock, Music, Pencil, Rocket, Flame, Leaf,
  Monitor, Package, Layers, Phone, Video, Image as ImageIcon,
} from 'lucide-react';

// ── Space metadata helpers ────────────────────────────────────────────────────

const ICON_MAP = {
  Briefcase, User, Users, Calendar, Star, Mic: MicIcon, CheckCircle,
  Code, Coffee, BookOpen, Heart, Smile, Award, Mail, Bell, Globe,
  Folder, Archive, Bookmark, Hash, Flag, Target, Zap: ZapIcon,
  TrendingUp, MapPin, Clock, Music, Pencil, Rocket, Flame, Leaf,
  Monitor, Package, Layers, Phone, Video, Image: ImageIcon,
};

const BUILT_IN_SPACE_META = {
  work:      { Icon: Briefcase,    color: '#4a7fcb', bg: '#e8f0fc' },
  personal:  { Icon: User,         color: '#b45837', bg: '#f5e0d4' },
  '1:1':     { Icon: Users,        color: '#7c5fc2', bg: '#ede8f8' },
  standup:   { Icon: Calendar,     color: '#c47a00', bg: '#fef3d6' },
  planning:  { Icon: Star,         color: '#5c6e00', bg: '#eef1d6' },
  interview: { Icon: MicIcon,      color: '#9c6a4a', bg: '#f5e8dc' },
  review:    { Icon: CheckCircle,  color: '#2d7a60', bg: '#d4f0e8' },
};

function getSpaceMeta(tag) {
  if (BUILT_IN_SPACE_META[tag]) return BUILT_IN_SPACE_META[tag];
  try {
    const custom = JSON.parse(localStorage.getItem('steno:customSpaces') || '[]');
    const found = custom.find((s) => s.name === tag);
    if (found) {
      const Icon = ICON_MAP[found.icon] ?? Star;
      return { Icon, color: found.color, bg: found.bg };
    }
  } catch {}
  return { Icon: Folder, color: '#9c9285', bg: '#f0ede6' };
}

// ── Inline space tag strip ────────────────────────────────────────────────────

function SpaceTagStrip({ currentTags, allTags, onToggle }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const unassigned = allTags.filter((t) => !currentTags.includes(t));

  return (
    <div className="no-drag flex items-center gap-1.5 flex-wrap" style={{ flex: 1, minWidth: 0 }}>
      {/* Active space chips */}
      {currentTags.map((tag) => {
        const { Icon, color, bg } = getSpaceMeta(tag);
        return (
          <span
            key={tag}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px 3px 7px', borderRadius: 6, background: bg, border: `1px solid ${color}33`, fontSize: 12, fontWeight: 500, color }}
          >
            <Icon size={11} style={{ flexShrink: 0 }} />
            <span className="capitalize">{tag}</span>
            <button
              onClick={() => onToggle(tag)}
              style={{ display: 'flex', alignItems: 'center', marginLeft: 2, color, opacity: 0.5, background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
              onMouseEnter={e => e.currentTarget.style.opacity = 1}
              onMouseLeave={e => e.currentTarget.style.opacity = 0.5}
              title={`Remove from ${tag}`}
            >
              <XIcon size={10} />
            </button>
          </span>
        );
      })}

      {/* Add space picker */}
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 6, background: 'transparent', border: '1px dashed var(--ink-ghost)', fontSize: 12, color: 'var(--ink-faint)', cursor: 'pointer', transition: 'all 0.12s' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--ink-faint)'; e.currentTarget.style.color = 'var(--ink-muted)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--ink-ghost)'; e.currentTarget.style.color = 'var(--ink-faint)'; }}
        >
          <Plus size={11} /> Add space
        </button>

        {open && unassigned.length > 0 && (
          <div className="absolute top-full left-0 mt-1.5 z-50 animate-fade-in"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '6px', minWidth: 180 }}>
            {unassigned.map((tag) => {
              const { Icon, color, bg } = getSpaceMeta(tag);
              return (
                <button
                  key={tag}
                  onClick={() => { onToggle(tag); setOpen(false); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 10px', borderRadius: 7, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--ink)', transition: 'background 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f0ede6'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <span style={{ width: 22, height: 22, borderRadius: 6, background: bg, border: `1px solid ${color}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Icon size={12} color={color} />
                  </span>
                  <span className="capitalize">{tag}</span>
                </button>
              );
            })}
          </div>
        )}
        {open && unassigned.length === 0 && (
          <div className="absolute top-full left-0 mt-1.5 z-50"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '10px 14px', fontSize: 12, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>
            All spaces applied ✓
          </div>
        )}
      </div>
    </div>
  );
}

// ── Record button ─────────────────────────────────────────────────────────────

function RecordButton({ status, loadingProgress, onClick }) {
  const isRecording = status === 'recording';
  const isLoading   = status === 'loading';
  const isPaused    = status === 'paused';

  if (isLoading && loadingProgress) {
    return (
      <button disabled className="relative flex items-center gap-2 px-4 py-[7px] rounded-[8px] bg-[#f5f2e9] border border-[#ddd9cf] text-[#9c9285] overflow-hidden" style={{ minWidth: 130 }}>
        <div className="absolute inset-0 bg-[#eef1d6] transition-all duration-300" style={{ width: `${loadingProgress.pct ?? 0}%` }} />
        <Loader size={12} className="animate-spin relative z-10 text-[#5c6e00] flex-shrink-0" />
        <span className="relative z-10 truncate text-[12px]">{loadingProgress.message ?? 'Loading…'}</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      disabled={isLoading}
      style={{ borderRadius: 8, fontSize: 13, fontWeight: 600, padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', transition: 'all 0.15s', border: '1px solid transparent' }}
      className={
        isRecording
          ? 'bg-[#f5e0d4] dark:bg-[#3a1a0a] text-[#b45837] dark:text-[#e8855a] border-[#e8c4ae] dark:border-[#5a2a18] animate-record-pulse'
          : isPaused
          ? 'bg-[#fef3d6] dark:bg-[#302010] text-[#c47a00] dark:text-[#e8a030] border-[#f5d98a] dark:border-[#503010]'
          : 'bg-[#eef1d6] dark:bg-[#253015] text-[#3d5200] dark:text-[#8aaa00] border-[#d4e0a0] dark:border-[#364820] hover:bg-[#e4ebbd] dark:hover:bg-[#2d3a1a]'
      }
    >
      {isRecording ? <MicOff size={13} /> : <Mic size={13} />}
      {isRecording ? 'Pause' : isPaused ? 'Resume' : 'Record'}
    </button>
  );
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function Timer({ startedAt, isRunning }) {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (isRunning && startedAt) {
      intervalRef.current = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [isRunning, startedAt]);

  if (!startedAt) return null;
  const totalSecs = Math.floor(elapsed / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return (
    <span className="text-[11px] text-[#9c9285] dark:text-[#7a7268] font-mono tabular-nums">
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </span>
  );
}

// ── Workspace ─────────────────────────────────────────────────────────────────

export function Workspace() {
  const {
    activeMeetingId, setView,
    recordingStatus, statusMessage, loadingProgress,
    liveSummaryEnabled, summaryIntervalSecs,
    liveTxEnabled,
    inputDeviceId, outputDeviceId, micDeviceId,
    passthroughEnabled, captureMyVoice,
    notesView, setNotesView,
    isGenerating, setIsGenerating,
    generatedNotes, setGeneratedNotes,
    resetWorkspaceState,
    liveSegments, setLiveSegments, setLiveTranscript, setLiveSummary,
    pendingImportFile, clearPendingImportFile,
    setRecordingStatus, setStatusMessage,
  } = useAppStore();

  const [meeting, setMeeting]       = useState(null);
  const [settingsOpen, setSettings] = useState(false);
  const [startedAt, setStartedAt]   = useState(null);
  const [initialDoc, setInitialDoc] = useState('{}');
  const [exportDone, setExportDone] = useState(false);
  const [isDictating, setIsDictating]       = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [dictationError, setDictationError] = useState(null);
  const editorInstanceRef           = useRef(null);
  const audioRef                    = useRef(null);
  const generatedRef                = useRef('');
  const summaryTimerRef             = useRef(null);

  const loadMeeting = useCallback(async () => {
    if (!activeMeetingId) return;
    const data = await window.api.db.getMeeting(activeMeetingId);
    setMeeting(data);
    if (data?.notes?.human_doc_json) setInitialDoc(data.notes.human_doc_json);
    if (data?.notes?.enhanced_md) {
      setGeneratedNotes(data.notes.enhanced_md);
      generatedRef.current = data.notes.enhanced_md;
    }

    // Restore saved transcript segments when the in-memory recorder buffer is gone
    // (e.g. after navigating away and back, or after an app restart)
    if (!recorder.currentTranscript && !recorder.mainRecBuffer?.length) {
      const saved = await window.api.db.getSegments(activeMeetingId);
      if (saved?.length) {
        setLiveSegments(saved.map((s) => ({ id: s.id ?? (Date.now() + Math.random()), ...s })));
        // Rebuild currentTranscript so the recorder-based canGenerate check also passes
        recorder.currentTranscript = saved.map((s) => s.text).join(' ');
      }
    }

  }, [activeMeetingId]);

  useEffect(() => { loadMeeting(); }, [loadMeeting]);

  useEffect(() => {
    if (!audioRef.current || !meeting?.audio_path) return;
    audioRef.current.src = `file://${meeting.audio_path}`;
  }, [meeting?.audio_path]);

  // ── File import pipeline ──
  useEffect(() => {
    if (!pendingImportFile || !activeMeetingId) return;

    const file = pendingImportFile;
    clearPendingImportFile();

    // Clear any stale transcript state from a previous session
    recorder.currentTranscript = '';
    setLiveSegments([]);
    setLiveTranscript('');

    recorder.transcribeFile(file)
      .then(async () => {
        const { liveSegments: segs } = useAppStore.getState();
        if (segs.length) {
          await window.api.db.upsertSegments(activeMeetingId,
            segs.map((s) => ({ text: s.text, speaker: s.speaker ?? null, createdAt: s.timestamp ?? Date.now() }))
          );
        }
        await window.api.db.updateMeeting(activeMeetingId, { status: 'done', ended_at: Date.now() });
        setRecordingStatus('paused');
        setStatusMessage('Import complete — hit Generate to create meeting notes');
      })
      .catch((err) => {
        console.error('[Import] Failed:', err);
        setRecordingStatus('error');
        setStatusMessage('Import failed — ' + err.message);
      });
  }, [pendingImportFile, activeMeetingId]);

  // ── Recording toggle ──

  const handleRecordToggle = useCallback(async () => {
    const status = recorder.isRecording;

    if (status) {
      await recorder.pause();
      clearTimeout(summaryTimerRef.current);
      clearTimeout(recorder._summaryTimer);
      if (activeMeetingId) {
        // Persist live segments to DB so they survive navigation / restarts
        const currentSegments = useAppStore.getState().liveSegments;
        if (currentSegments.length > 0) {
          await window.api.db.upsertSegments(activeMeetingId,
            currentSegments.map((s) => ({ text: s.text, speaker: s.speaker ?? null, createdAt: s.timestamp ?? Date.now() }))
          );
        }
        await window.api.db.updateMeeting(activeMeetingId, {
          status: 'paused', ended_at: Date.now(),
          duration_ms: startedAt ? Date.now() - startedAt : null,
        });
      }
    } else {
      if (!activeMeetingId) return;
      const isResume = recorder.sessionTimestamp !== null;
      if (!isResume) {
        recorder.sessionTimestamp = recorder._timestamp();
        setLiveSegments([]); setLiveTranscript(''); setLiveSummary('');
      }
      await recorder.start({
        inputDeviceId, outputDeviceId: micDeviceId || outputDeviceId,
        captureMyVoice, liveTx: liveTxEnabled, passthroughOn: passthroughEnabled,
      });
      const now = Date.now();
      if (!isResume) setStartedAt(now);
      await window.api.db.updateMeeting(activeMeetingId, {
        status: 'recording',
        started_at: isResume ? undefined : now,
        folder_path: recorder.sessionTimestamp,
      });
      if (liveSummaryEnabled) {
        recorder.scheduleRollingSummary({ intervalSecs: summaryIntervalSecs, meetingId: activeMeetingId });
      }
    }
  }, [activeMeetingId, inputDeviceId, outputDeviceId, micDeviceId, captureMyVoice,
      liveTxEnabled, passthroughEnabled, liveSummaryEnabled, summaryIntervalSecs, startedAt]);

  // ── Generate ──

  const handleGenerate = useCallback(async () => {
    if (!activeMeetingId) return;
    setIsGenerating(true);
    setNotesView('generated');

    if (recorder.mainRecBuffer.length > 0) {
      // Full re-transcription from raw audio buffer
      await recorder.enhanceTranscript();
      if (recorder.currentTranscript) {
        await window.api.db.upsertSegments(activeMeetingId, [{
          text: recorder.currentTranscript, speaker: null, createdAt: Date.now(),
        }]);
      }
    } else if (liveSegments.length > 0 && !recorder.currentTranscript) {
      // Restore currentTranscript from in-memory live segments (survived navigation via loadMeeting)
      recorder.currentTranscript = liveSegments.map((s) => s.text).join(' ');
    }

    const meetingData    = await window.api.db.getMeeting(activeMeetingId);
    const humanText      = meetingData?.notes?.human_doc_text ?? '';
    // Use in-memory transcript, then fall back to DB-persisted segments
    const savedSegments  = recorder.currentTranscript ? [] : await window.api.db.getSegments(activeMeetingId);
    const transcriptText = recorder.currentTranscript ||
      liveSegments.map((s) => s.text).join(' ') ||
      savedSegments.map((s) => s.text).join(' ');

    generatedRef.current = '';
    setGeneratedNotes('');
    window.api.onMergeChunk((chunk) => {
      generatedRef.current += chunk;
      setGeneratedNotes(generatedRef.current);
    });

    try {
      const res = await window.api.generateMerge({ humanNotesText: humanText, transcriptText, meetingId: activeMeetingId });
      if (res.ok) {
        if (!meeting?.title || meeting.title === 'New Meeting' || meeting.title === 'Untitled Meeting' || meeting.title === 'New Note') {
          const titleRes = await window.api.generateTitle({ transcriptText, notesText: humanText, meetingId: activeMeetingId });
          if (titleRes?.title) setMeeting((m) => m ? { ...m, title: titleRes.title } : m);
        }

        const wavBytes = recorder.getWavBytes();
        if (wavBytes && recorder.sessionTimestamp) {
          const audioPath = `recordings/${recorder.sessionTimestamp}/recording.wav`;
          await window.api.saveAudio({ bytes: wavBytes, filePath: audioPath });
          await window.api.db.updateMeeting(activeMeetingId, { status: 'done', ended_at: Date.now(), audio_path: audioPath });
        } else {
          await window.api.db.updateMeeting(activeMeetingId, { status: 'done', ended_at: Date.now() });
        }
        loadMeeting();
      }
    } finally {
      window.api.offMergeChunk();
      setIsGenerating(false);
    }
  }, [activeMeetingId, meeting, loadMeeting]);

  const handleTitleChange = useCallback(async (title) => {
    setMeeting((m) => m ? { ...m, title } : m);
  }, []);

  const handleTitleBlur = useCallback(async () => {
    if (!activeMeetingId || !meeting?.title) return;
    await window.api.db.updateMeeting(activeMeetingId, { title: meeting.title });
  }, [activeMeetingId, meeting?.title]);

  const handleTemplate = useCallback((doc) => {
    editorInstanceRef.current?.commands.setContent(doc);
  }, []);

  const handleExportMarkdown = () => {
    const text = notesView === 'generated' ? generatedNotes : '';
    if (!text) return;
    const blob = new Blob([text], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `${(meeting?.title || 'meeting').replace(/[^a-z0-9]/gi, '-').toLowerCase()}.md` });
    a.click();
    URL.revokeObjectURL(url);
    setExportDone(true); setTimeout(() => setExportDone(false), 2000);
  };

  const isRecording = recorder.isRecording;
  // Allow Generate when: in-memory buffer/transcript is present OR we have saved segments (restored from DB)
  const canGenerate = !isGenerating && (
    recorder.mainRecBuffer?.length > 0 ||
    recorder.currentTranscript ||
    liveSegments.length > 0
  );

  // Current meeting tags
  const currentTags = (() => { try { return JSON.parse(meeting?.tags || '[]'); } catch { return []; } })();

  // All available spaces — built-in + custom (kept in sync with sidebar via localStorage)
  const ALL_WORKSPACE_TAGS = (() => {
    const builtIn = ['work','personal','1:1','standup','planning','interview','review'];
    try {
      const custom = JSON.parse(localStorage.getItem('steno:customSpaces') || '[]').map((s) => s.name);
      const order  = JSON.parse(localStorage.getItem('steno:spaceOrder')   || 'null');
      const all    = [...new Set([...builtIn, ...custom])];
      if (Array.isArray(order)) return order.filter((n) => all.includes(n)).concat(all.filter((n) => !order.includes(n)));
      return all;
    } catch { return builtIn; }
  })();

  return (
    <div className="flex flex-col h-full bg-[#faf8f2] dark:bg-[#201d16]">

      {/* ── Top bar ── */}
      <div className="flex items-center gap-2 border-b border-[#ede9df] dark:border-[#46412e] flex-shrink-0 titlebar-drag bg-[#faf8f2]/90 dark:bg-[#201d16]/95 backdrop-blur-sm"
        style={{ paddingLeft: 88, paddingRight: 16, paddingTop: 10, paddingBottom: 10 }}>
        <button
          onClick={async () => {
            // Guard: editor ref is nulled on unmount (generated tab) or may point to
            // a destroyed TipTap instance. getText() on a destroyed editor throws
            // because TipTap v3 nulls editor.schema in destroy().
            const editorText = (() => {
              try {
                const ed = editorInstanceRef.current;
                if (!ed || ed.isDestroyed) return '';
                return ed.getText?.() ?? '';
              } catch {
                return '';
              }
            })();
            const isBlank =
              (!meeting?.title || meeting.title === 'New Note') &&
              liveSegments.length === 0 &&
              !generatedNotes &&
              editorText.trim() === '';
            try {
              if (isBlank && activeMeetingId) {
                await window.api.db.deleteMeeting(activeMeetingId);
              }
            } catch {
              // Deletion failure should never block navigation
            }
            setView('library');
            resetWorkspaceState();
          }}
          className="btn-icon no-drag"
          aria-label="Back"
        >
          <ArrowLeft size={15} />
        </button>

        <input
          type="text"
          value={meeting?.title ?? ''}
          onChange={(e) => handleTitleChange(e.target.value)}
          onBlur={handleTitleBlur}
          placeholder="Meeting title…"
          className="flex-1 min-w-0 text-[15px] font-semibold text-[#1a1814] dark:text-[#e8e4db] placeholder:text-[#c4bdb5] dark:placeholder:text-[#5e5850] outline-none no-drag tracking-[-0.015em]"
          style={{ background: 'transparent', border: 'none' }}
        />

        <button
          className="no-drag btn-icon flex-shrink-0"
          onClick={async () => {
            if (!activeMeetingId) return;
            const { starred } = await window.api.db.toggleStar(activeMeetingId);
            setMeeting((m) => m ? { ...m, starred } : m);
          }}
          aria-label={meeting?.starred ? 'Remove star' : 'Star this note'}
          title={meeting?.starred ? 'Remove star' : 'Star this note'}
        >
          <Star
            size={15}
            fill={meeting?.starred ? '#c47a00' : 'none'}
            color={meeting?.starred ? '#c47a00' : 'currentColor'}
          />
        </button>

        <div className="flex items-center gap-1.5 no-drag flex-shrink-0">
          <Timer startedAt={startedAt} isRunning={isRecording} />
          <AudioBars />

          <RecordButton status={recordingStatus} loadingProgress={loadingProgress} onClick={handleRecordToggle} />

          <button
            onClick={handleGenerate}
            disabled={!canGenerate || isGenerating}
            style={{ borderRadius: 8, fontSize: 13, fontWeight: 600, padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', transition: 'all 0.15s', border: '1px solid transparent' }}
            className={`${!canGenerate || isGenerating ? 'opacity-40 cursor-not-allowed' : ''} bg-[#e8eaf5] dark:bg-[#252035] text-[#3a3d7a] dark:text-[#a8abda] border-[#c8cbea] dark:border-[#383a60] hover:bg-[#daddf0] dark:hover:bg-[#2e3045]`}
          >
            {isGenerating
              ? <><Loader size={12} className="animate-spin flex-shrink-0" /> Generating…</>
              : <><Sparkles size={12} className="flex-shrink-0" /> Generate</>
            }
          </button>

          <button
            onClick={() => setSettings((o) => !o)}
            className="btn-icon"
            title="Settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* ── Loading progress strip — only while model loads or generating ── */}
      {(recordingStatus === 'loading' || isGenerating) && statusMessage && (
        <div className="relative px-4 py-1.5 bg-[#fefcf7] dark:bg-[#2a261c] border-b border-[#ede9df] dark:border-[#46412e] flex items-center gap-2 flex-shrink-0 overflow-hidden">
          {loadingProgress?.pct != null && (
            <div
              className="absolute inset-0 bg-[#eef1d6] dark:bg-[#253015] transition-all duration-300 pointer-events-none"
              style={{ width: `${loadingProgress.pct}%` }}
            />
          )}
          <Loader size={11} className="animate-spin text-[#5c6e00] relative z-10 flex-shrink-0" />
          <span className="text-[11px] text-[#9c9285] dark:text-[#6b6358] truncate relative z-10">{statusMessage}</span>
        </div>
      )}

      {/* ── Main split body ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left: Notes + Todos */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

          {/* Notes view toggle bar */}
          <div className="flex items-center gap-2 px-4 pt-2.5 pb-2 border-b border-[#ede9df] dark:border-[#46412e] flex-shrink-0">
            <div style={{ display: 'flex', background: 'var(--bg-surface3)', borderRadius: 8, padding: 3, gap: 2 }}>
              <button
                onClick={() => setNotesView('human')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 13px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: notesView === 'human' ? 600 : 500,
                  background: notesView === 'human' ? 'var(--bg-surface)' : 'transparent',
                  color: notesView === 'human' ? 'var(--ink)' : 'var(--ink-faint)',
                  boxShadow: notesView === 'human' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                  transition: 'all 0.15s',
                }}
              >
                <Pencil size={12} style={{ opacity: notesView === 'human' ? 1 : 0.6 }} />
                My Notes
              </button>
              <button
                onClick={() => setNotesView('generated')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 13px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: notesView === 'generated' ? 600 : 500,
                  background: notesView === 'generated' ? 'var(--bg-surface)' : 'transparent',
                  color: notesView === 'generated' ? 'var(--ink)' : 'var(--ink-faint)',
                  boxShadow: notesView === 'generated' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                  transition: 'all 0.15s',
                }}
              >
                <Sparkles size={12} style={{ opacity: notesView === 'generated' ? 1 : 0.6 }} />
                Generated
                {generatedNotes && (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#5c6e00', flexShrink: 0 }} />
                )}
              </button>
            </div>

            {/* Space tags — inline after the tab switcher */}
            <SpaceTagStrip
              currentTags={currentTags}
              allTags={ALL_WORKSPACE_TAGS}
              onToggle={async (tag) => {
                const newTags = currentTags.includes(tag)
                  ? currentTags.filter((t) => t !== tag)
                  : [...currentTags, tag];
                await window.api.db.updateMeeting(activeMeetingId, { tags: JSON.stringify(newTags) });
                setMeeting((m) => m ? { ...m, tags: JSON.stringify(newTags) } : m);
              }}
            />

            <div className="ml-auto flex items-center gap-1 flex-shrink-0">
              {notesView === 'generated' && generatedNotes && (
                <Button variant="ghost" size="xs" onClick={handleExportMarkdown}>
                  <Download size={12} />
                  {exportDone ? 'Saved!' : 'Export'}
                </Button>
              )}
            </div>
          </div>

          {/* Notes content */}
          <div className="flex-1 overflow-y-auto min-h-0 flex flex-col bg-[#faf8f2] dark:bg-[#201d16] relative">
            {notesView === 'human' ? (
              <div className="flex-1 px-3 pt-3 pb-16 min-h-0 flex flex-col">
                <NotesEditor
                  meetingId={activeMeetingId}
                  initialDoc={initialDoc}
                  editorRef={editorInstanceRef}
                  onTemplate={handleTemplate}
                />
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                <GeneratedNotesView md={generatedNotes} isStreaming={isGenerating} />
              </div>
            )}

            {/* Floating dictation pill — inserts speech directly into the editor */}
            {notesView === 'human' && (
              <div className="absolute bottom-4 left-0 right-0 flex flex-col items-center gap-2 pointer-events-none">
                {dictationError && (
                  <div className="pointer-events-auto px-3 py-1.5 rounded-lg text-xs font-medium max-w-xs text-center"
                    style={{ background: 'rgba(180,88,55,0.12)', color: '#b45837', border: '1px solid rgba(180,88,55,0.25)' }}>
                    {dictationError}
                  </div>
                )}
                <button
                  disabled={isTranscribing}
                  onClick={async () => {
                    setDictationError(null);
                    if (isDictating) {
                      setIsDictating(false);
                      setIsTranscribing(true);
                      const text = await recorder.stopDictation();
                      setIsTranscribing(false);
                      if (text) {
                        const editor = editorInstanceRef.current;
                        if (editor) {
                          editor.commands.focus();
                          editor.commands.insertContent(text + ' ');
                        }
                      } else if (text === null && recorder._dictationFrames === null) {
                        // transcription returned nothing — likely empty audio
                        setDictationError('Nothing heard — try speaking closer to the mic');
                        setTimeout(() => setDictationError(null), 4000);
                      }
                      return;
                    }
                    setIsDictating(true);
                    const ok = await recorder.startDictation();
                    if (!ok) {
                      setIsDictating(false);
                      setDictationError('Model not ready — try recording a meeting first to load the AI model');
                      setTimeout(() => setDictationError(null), 5000);
                    }
                  }}
                  className="pointer-events-auto flex items-center justify-center rounded-full transition-all duration-150 select-none no-drag"
                  style={{
                    width: 56, height: 56,
                    background: isTranscribing
                      ? 'rgba(255,255,255,0.92)'
                      : isDictating ? '#5c6e00' : 'rgba(255,255,255,0.92)',
                    border: `1.5px solid ${isDictating ? '#5c6e00' : 'rgba(200,196,188,0.7)'}`,
                    boxShadow: isDictating
                      ? '0 0 0 6px rgba(92,110,0,0.15), 0 4px 16px rgba(26,24,20,0.18)'
                      : '0 4px 16px rgba(26,24,20,0.14)',
                    backdropFilter: 'blur(8px)',
                    color: isDictating ? '#fff' : '#5c5448',
                    opacity: isTranscribing ? 0.6 : 1,
                  }}
                >
                  {isTranscribing
                    ? <Loader size={20} className="animate-spin" />
                    : isDictating
                      ? <span className="animate-record-pulse" style={{ width: 14, height: 14, borderRadius: 3, background: '#fff', flexShrink: 0 }} />
                      : <Mic size={22} />
                  }
                </button>
              </div>
            )}
          </div>

        </div>

        {/* Right: Summary / Transcript — visible when either feature is enabled */}
        {(liveTxEnabled || liveSummaryEnabled) && (
          <div className="w-80 flex-shrink-0 flex flex-col min-h-0 border-l border-[#e8e4da] dark:border-[#46412e]">
            <RightPane audioRef={audioRef} />
          </div>
        )}
      </div>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettings(false)} />
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function GeneratedNotesView({ md, isStreaming }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [md]);

  if (isStreaming && !md) return (
    <div className="flex items-center justify-center h-full gap-2.5 text-[13px] text-[#7c5fc2]">
      <Loader size={15} className="animate-spin" /> Generating notes…
    </div>
  );

  if (!md) return (
    <div className="flex flex-col items-center justify-center h-full text-center p-7">
      <div className="w-10 h-10 rounded-2xl bg-[#ede8f8] flex items-center justify-center mb-3">
        <Sparkles size={18} className="text-[#7c5fc2]" />
      </div>
      <p className="text-[13px] font-medium text-[#5c5448] dark:text-[#a09890] mb-1">Generated Notes</p>
      <p className="text-[12px] text-[#9c9285] dark:text-[#6b6358] leading-relaxed max-w-[200px]">
        Hit "Generate" to merge your notes with the transcript into polished meeting notes.
      </p>
    </div>
  );

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
      <div className="prose text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: markdownToHtml(md) }} />
    </div>
  );
}


function markdownToHtml(md) {
  if (!md) return '';
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^#{3}\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^#{2}\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^\|\s*(.*?)\s*\|$/gm, (_, row) => {
      const cells = row.split('|').map((c) => c.trim());
      const isHeader = cells.every((c) => /^-+$/.test(c));
      if (isHeader) return '';
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    })
    .replace(/((<tr>.*<\/tr>\n?)+)/gs, '<table>$1</table>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, '<ul>$&</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[a-z])(.*)/gm, (m) => m.trim() ? `<p>${m}</p>` : '')
    .replace(/<p><\/p>/g, '');
}
