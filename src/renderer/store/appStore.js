import { create } from 'zustand';

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
  notesView: 'human',        // 'human' | 'generated'

  // ── Device settings ────────────────────────────────────────────────────────
  devices: [],
  inputDeviceId: '',
  outputDeviceId: '',
  micDeviceId: '',
  passthroughEnabled: false,
  captureMyVoice: false,
  liveTxEnabled: true,
  liveSummaryEnabled: true,
  summaryIntervalSecs: 30,

  // ── EQ settings ────────────────────────────────────────────────────────────
  eqSensitivity: 5,
  eqReactivity: 5,
  eqMinSpeech: 3,
  eqSilence: 5,

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
  removeLiveSegment: (id) => set((s) => ({ liveSegments: s.liveSegments.filter((seg) => seg.id !== id) })),
  setLiveTranscript: (t) => set({ liveTranscript: t }),
  setLiveSegments:   (segs) => set({ liveSegments: segs }),

  setLiveSummary:   (s) => set({ liveSummary: s }),
  setSummaryState:  (s) => set({ summaryState: s }),
  setRightTab:      (t) => set({ rightTab: t }),
  toggleRightPane:  () => set((s) => ({ rightPaneOpen: !s.rightPaneOpen })),

  setIsGenerating:  (b) => set({ isGenerating: b }),
  setGeneratedNotes:(n) => set({ generatedNotes: n }),
  setNotesView:    (v) => set({ notesView: v }),

  setDevices:          (d) => set({ devices: d }),
  setInputDeviceId:    (id) => set({ inputDeviceId: id }),
  setOutputDeviceId:   (id) => set({ outputDeviceId: id }),
  setMicDeviceId:      (id) => set({ micDeviceId: id }),
  setPassthrough:      (b) => set({ passthroughEnabled: b }),
  setCaptureMyVoice:   (b) => set({ captureMyVoice: b }),
  setLiveTx:           (b) => set({ liveTxEnabled: b }),
  setLiveSummaryOn:    (b) => set({ liveSummaryEnabled: b }),
  setSummaryInterval:  (n) => set({ summaryIntervalSecs: n }),

  setEq: (field, val) => set({ [field]: val }),

  setDarkMode: (b) => {
    localStorage.setItem('steno:darkMode', String(b));
    set({ darkMode: b });
  },

  resetWorkspaceState: () => set({
    recordingStatus: 'idle',
    statusMessage: 'Ready',
    liveTranscript: '',
    liveSegments: [],
    liveSummary: '',
    summaryState: '',
    isGenerating: false,
    generatedNotes: '',
    notesView: 'human',
  }),
}));
