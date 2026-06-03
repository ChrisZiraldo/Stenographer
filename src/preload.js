import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  /**
   * Save a transcript to disk.
   * @param {{ text: string, filePath: string }} args
   */
  saveTranscript: (args) => ipcRenderer.invoke('save-transcript', args),

  /**
   * Generate meeting notes via the Cursor SDK agent.
   * @param {{ transcriptText: string, notesPath: string }} args
   */
  generateNotes: (args) => ipcRenderer.invoke('generate-notes', args),

  /**
   * Save raw audio bytes to disk (e.g. a WAV recording).
   * @param {{ bytes: Uint8Array, filePath: string }} args
   */
  saveAudio: (args) => ipcRenderer.invoke('save-audio', args),
});
