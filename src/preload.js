import { contextBridge, ipcRenderer } from 'electron';

// ── Streaming chunk handlers ──────────────────────────────────────────────────
// Module-level callbacks allow the renderer to register/deregister a handler
// for each stream type without managing ipcRenderer listeners directly.
let _notesChunkCb   = null;
let _summaryChunkCb = null;

ipcRenderer.on('notes-chunk',   (_event, text) => { if (_notesChunkCb)   _notesChunkCb(text);   });
ipcRenderer.on('summary-chunk', (_event, text) => { if (_summaryChunkCb) _summaryChunkCb(text); });

contextBridge.exposeInMainWorld('api', {
  /**
   * Save a transcript to disk.
   * @param {{ text: string, filePath: string }} args
   */
  saveTranscript: (args) => ipcRenderer.invoke('save-transcript', args),

  /**
   * Generate and stream meeting notes via the Cursor SDK agent.
   * Text arrives incrementally via onNotesChunk; the final markdown is saved
   * to notesPath by main.js when the run completes.
   * @param {{ transcriptText: string, notesPath: string }} args
   */
  generateNotes: (args) => ipcRenderer.invoke('generate-notes', args),

  /**
   * Generate and stream a rolling "so far" summary via the Cursor SDK agent.
   * Text arrives incrementally via onSummaryChunk.
   * @param {{ prevSummary: string, deltaText: string }} args
   */
  generateSummary: (args) => ipcRenderer.invoke('generate-summary', args),

  /**
   * Save raw audio bytes to disk (e.g. a WAV recording).
   * @param {{ bytes: number[], filePath: string }} args
   */
  saveAudio: (args) => ipcRenderer.invoke('save-audio', args),

  // ── Streaming callbacks ───────────────────────────────────────────────────

  /** Register a callback that fires for each streamed notes chunk. */
  onNotesChunk:   (cb) => { _notesChunkCb = cb; },
  /** Deregister the notes chunk callback. */
  offNotesChunk:  ()   => { _notesChunkCb = null; },

  /** Register a callback that fires for each streamed summary chunk. */
  onSummaryChunk:  (cb) => { _summaryChunkCb = cb; },
  /** Deregister the summary chunk callback. */
  offSummaryChunk: ()   => { _summaryChunkCb = null; },

  /** Open the recordings folder in Finder. */
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),
});
