import { create } from 'zustand';
import { recorder } from '../engine/recorder.js';

export const useAppStore = create((set, get) => ({
  // ── Navigation ─────────────────────────────────────────────────────────────
  view: 'library',          // 'library' | 'workspace'
  activeMeetingId: null,

  // ── Library data ──────────────────────────────────────────────────────────
  meetings: [],
  globalTodos: [],
  searchQuery: '',
  searchResults: [],

  // ── Workspace / recording state ───────────────────────────────────────────
  recordingStatus: 'idle',   // 'idle' | 'loading' | 'recording' | 'paused' | 'error'
  statusMessage: 'Ready',
  loadingProgress: null,     // { message, pct } during model load
  audioLevel: 0,
  liveTranscript: '',        // live segments (right pane Transcript tab)
  liveSegments: [],          // [{ id, text, speaker, timestamp }]
  liveSummary: '',           // rolling summary (right pane Summary tab)
  summaryState: '',          // 'Transcribing…' | 'Summarising…' | ''
  rightTab: 'transcript',    // 'summary' | 'transcript'
  rightPaneOpen: true,
  isGenerating: false,
  generatedNotes: '',
  notesView: 'human',        // 'human' | 'generated' | 'final'
  pendingImportFile: null,   // File object waiting to be transcribed in Workspace

  // ── Device settings ────────────────────────────────────────────────────────
  devices: [],
  micDeviceId: '',
  loopbackEnabled: true,
  micEnabled: true,
  liveTxEnabled: true,
  liveSummaryEnabled: true,
  summaryIntervalSecs: 30,

  // ── EQ settings ────────────────────────────────────────────────────────────
  eqSensitivity: 5,
  eqReactivity: 5,
  eqMinSpeech: 3,
  eqSilence: 5,

  // ── API ────────────────────────────────────────────────────────────────────
  cursorApiKey: '',

  // ── Generation model config ────────────────────────────────────────────────
  genProvider:     'cursor',
  cursorModel:     'composer-2.5',
  ollamaEndpoint:  'http://localhost:11434',
  ollamaModel:     '',
  localModelPath:  '',

  // ── Theme ──────────────────────────────────────────────────────────────────
  darkMode: (() => { try { return localStorage.getItem('steno:darkMode') === 'true'; } catch { return false; } })(),

  // ── Actions ────────────────────────────────────────────────────────────────

  setView: (view) => set({ view }),
  setActiveMeeting: (id) => set({ activeMeetingId: id, view: 'workspace' }),
  setMeetings: (meetings) => set({ meetings }),
  setGlobalTodos: (todos) => set({ globalTodos: todos }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (r) => set({ searchResults: r }),

  setRecordingStatus: (s) => set({ recordingStatus: s }),
  setStatusMessage:   (m) => set({ statusMessage: m }),
  setLoadingProgress: (p) => set({ loadingProgress: p }),
  setAudioLevel: (l) => set({ audioLevel: l }),

  appendLiveSegment: (seg) => set((s) => ({
    liveSegments: [...s.liveSegments, { id: Date.now() + Math.random(), ...seg }],
    liveTranscript: s.liveTranscript + (s.liveTranscript ? ' ' : '') +
      (seg.speaker ? `[${seg.speaker}] ` : '') + seg.text,
  })),
  removeLiveSegment: (id) => set((s) => {
    const remaining = s.liveSegments.filter((seg) => seg.id !== id);
    const rebuilt = remaining
      .map((seg) => (seg.speaker ? `[${seg.speaker}] ` : '') + seg.text)
      .join(' ');
    // Keep recorder in sync so generate sees the updated transcript. [B1]
    recorder.currentTranscript = rebuilt;
    return { liveSegments: remaining, liveTranscript: rebuilt };
  }),
  setLiveTranscript: (t) => set({ liveTranscript: t }),
  setLiveSegments:   (segs) => set({ liveSegments: segs }),

  setLiveSummary:   (s) => set({ liveSummary: s }),
  setSummaryState:  (s) => set({ summaryState: s }),
  setRightTab:      (t) => set({ rightTab: t }),
  toggleRightPane:  () => set((s) => ({ rightPaneOpen: !s.rightPaneOpen })),

  setIsGenerating:      (b) => set({ isGenerating: b }),
  setGeneratedNotes:    (n) => set({ generatedNotes: n }),
  setNotesView:         (v) => set({ notesView: v }),
  setPendingImportFile: (f) => set({ pendingImportFile: f }),
  clearPendingImportFile: () => set({ pendingImportFile: null }),

  setDevices:          (d) => set({ devices: d }),
  setMicDeviceId:      (id) => set({ micDeviceId: id }),
  setLoopbackEnabled:  (b) => set({ loopbackEnabled: b }),
  setMicEnabled:       (b) => set({ micEnabled: b }),
  setLiveTx:           (b) => set({ liveTxEnabled: b }),
  setLiveSummaryOn:    (b) => set({ liveSummaryEnabled: b }),
  setSummaryInterval:  (n) => set({ summaryIntervalSecs: n }),

  setEq: (field, val) => set({ [field]: val }),

  setCursorApiKey: (key) => set({ cursorApiKey: key }),

  setGenProvider:    (v) => set({ genProvider: v }),
  setCursorModel:    (v) => set({ cursorModel: v }),
  setOllamaEndpoint: (v) => set({ ollamaEndpoint: v }),
  setOllamaModel:    (v) => set({ ollamaModel: v }),
  setLocalModelPath: (v) => set({ localModelPath: v }),
  setGenConfig: (cfg) => set({
    ...(cfg.provider        !== undefined && { genProvider:    cfg.provider }),
    ...(cfg.cursorModel     !== undefined && { cursorModel:    cfg.cursorModel }),
    ...(cfg.ollamaEndpoint  !== undefined && { ollamaEndpoint: cfg.ollamaEndpoint }),
    ...(cfg.ollamaModel     !== undefined && { ollamaModel:    cfg.ollamaModel }),
    ...(cfg.localModelPath  !== undefined && { localModelPath: cfg.localModelPath }),
  }),

  setDarkMode: (b) => {
    localStorage.setItem('steno:darkMode', String(b));
    set({ darkMode: b });
  },

  resetWorkspaceState: () => set({
    recordingStatus: 'idle',
    statusMessage: 'Ready',
    loadingProgress: null, // [C13]
    audioLevel: 0,         // [C13]
    liveTranscript: '',
    liveSegments: [],
    liveSummary: '',
    summaryState: '',
    isGenerating: false,
    generatedNotes: '',
    notesView: 'human',
    pendingImportFile: null,
    rightTab: 'transcript',
  }),
}));
