import { contextBridge, ipcRenderer } from 'electron';

// ── Streaming chunk handlers ──────────────────────────────────────────────────
let _notesChunkCb           = null;
let _summaryChunkCb         = null;
let _mergeChunkCb           = null;
let _aiCommandChunkCb       = null;
let _devNavigateCb          = null;
let _triggerFileImportCb    = null;
let _modelDownloadProgressCb = null;

ipcRenderer.on('notes-chunk',              (_e, text)    => _notesChunkCb?.(text));
ipcRenderer.on('summary-chunk',            (_e, text)    => _summaryChunkCb?.(text));
ipcRenderer.on('merge-chunk',              (_e, text)    => _mergeChunkCb?.(text));
ipcRenderer.on('ai-command-chunk',         (_e, text)    => _aiCommandChunkCb?.(text));
ipcRenderer.on('dev:navigate',             (_e, payload) => _devNavigateCb?.(payload));
ipcRenderer.on('trigger-file-import',      ()            => _triggerFileImportCb?.());
ipcRenderer.on('model-download-progress',  (_e, payload) => _modelDownloadProgressCb?.(payload));

contextBridge.exposeInMainWorld('api', {
  // ── File I/O ───────────────────────────────────────────────────────────────
  saveTranscript: (args) => ipcRenderer.invoke('save-transcript', args),
  saveAudio:      (args) => ipcRenderer.invoke('save-audio', args),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),

  // ── Settings ───────────────────────────────────────────────────────────────
  getApiKey: ()    => ipcRenderer.invoke('settings:getApiKey'),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),

  getGenConfig:     ()         => ipcRenderer.invoke('settings:getGenConfig'),
  setGenConfig:     (cfg)      => ipcRenderer.invoke('settings:setGenConfig', cfg),
  listOllamaModels: (endpoint) => ipcRenderer.invoke('settings:listOllamaModels', endpoint),

  // ── Local model management ────────────────────────────────────────────────
  listModels:           ()        => ipcRenderer.invoke('models:list'),
  importModel:          ()        => ipcRenderer.invoke('models:import'),
  downloadModel:        (modelId)          => ipcRenderer.invoke('models:download', modelId),
  downloadModelUrl:     (url, filename)    => ipcRenderer.invoke('models:downloadUrl', { url, filename }),
  cancelModelDownload:  (modelId)          => ipcRenderer.invoke('models:cancelDownload', modelId),
  deleteModel:          (path)    => ipcRenderer.invoke('models:delete', path),
  onModelDownloadProgress:  (cb) => { _modelDownloadProgressCb = cb; },
  offModelDownloadProgress: ()   => { _modelDownloadProgressCb = null; },

  // ── AI generation ──────────────────────────────────────────────────────────
  generateNotes:   (args) => ipcRenderer.invoke('generate-notes', args),
  generateMerge:   (args) => ipcRenderer.invoke('generate-merge', args),
  generateSummary: (args) => ipcRenderer.invoke('generate-summary', args),
  generateTitle:   (args) => ipcRenderer.invoke('generate-title', args),
  aiCommand:       (args) => ipcRenderer.invoke('ai-command', args),

  // ── Streaming callbacks ────────────────────────────────────────────────────
  onNotesChunk:      (cb) => { _notesChunkCb = cb; },
  offNotesChunk:     ()   => { _notesChunkCb = null; },
  onSummaryChunk:    (cb) => { _summaryChunkCb = cb; },
  offSummaryChunk:   ()   => { _summaryChunkCb = null; },
  onMergeChunk:      (cb) => { _mergeChunkCb = cb; },
  offMergeChunk:     ()   => { _mergeChunkCb = null; },
  onAiCommandChunk:  (cb) => { _aiCommandChunkCb = cb; },
  offAiCommandChunk: ()   => { _aiCommandChunkCb = null; },

  // ── Dev navigation (dev-only, mouse-free screen switching) ─────────────────
  onDevNavigate:  (cb) => { _devNavigateCb = cb; },
  offDevNavigate: ()   => { _devNavigateCb = null; },

  // ── File import (triggered by File menu or import button) ─────────────────
  onTriggerFileImport:  (cb) => { _triggerFileImportCb = cb; },
  offTriggerFileImport: ()   => { _triggerFileImportCb = null; },

  // ── Database (all synchronous ops over IPC) ────────────────────────────────
  db: {
    listMeetings:   (opts)             => ipcRenderer.invoke('db:listMeetings', opts),
    getMeeting:     (id)               => ipcRenderer.invoke('db:getMeeting', id),
    createMeeting:  (opts)             => ipcRenderer.invoke('db:createMeeting', opts),
    updateMeeting:  (id, fields)       => ipcRenderer.invoke('db:updateMeeting', { id, fields }),
    deleteMeeting:  (id)               => ipcRenderer.invoke('db:deleteMeeting', id),
    saveNoteDoc:    (meetingId, doc)   => ipcRenderer.invoke('db:saveNoteDoc', { meetingId, ...doc }),
    saveSummary:    (meetingId, md)    => ipcRenderer.invoke('db:saveSummary', { meetingId, summaryMd: md }),
    saveGenerated:  (meetingId, md)    => ipcRenderer.invoke('db:saveGenerated', { meetingId, generatedMd: md }),
    upsertSegments:  (meetingId, segs)  => ipcRenderer.invoke('db:upsertSegments',  { meetingId, segments: segs }),
    replaceSegments: (meetingId, segs)  => ipcRenderer.invoke('db:replaceSegments', { meetingId, segments: segs }),
    getSegments:     (meetingId)        => ipcRenderer.invoke('db:getSegments', meetingId),
    getSpaces:      ()                 => ipcRenderer.invoke('db:getSpaces'),
    saveSpaces:     (spaces)           => ipcRenderer.invoke('db:saveSpaces', spaces),
    toggleStar:     (id)               => ipcRenderer.invoke('db:toggleStar', id),
    listTodos:          (opts)                    => ipcRenderer.invoke('db:listTodos', opts),
    upsertTodo:         (todo)                    => ipcRenderer.invoke('db:upsertTodo', todo),
    replaceHumanTodos:  (meetingId, tasks)        => ipcRenderer.invoke('db:replaceHumanTodos', { meetingId, tasks }),
    toggleTodo:     (id)               => ipcRenderer.invoke('db:toggleTodo', id),
    deleteTodo:     (id)               => ipcRenderer.invoke('db:deleteTodo', id),
    search:         (query, opts)      => ipcRenderer.invoke('db:search', { query, ...opts }),
  },
});
