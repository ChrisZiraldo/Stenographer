/**
 * Transcription engine — wraps parakeet.js for both segment and batch modes.
 *
 * Live mode (VAD-driven):
 *   await engine.loadModel(onProgress);
 *   const { text } = await engine.transcribeSegment(float32At16k);
 *
 * Batch mode (file):
 *   const { text } = await engine.transcribeFile(float32At16k, onChunk);
 */

import { getParakeetModel } from 'parakeet.js/hub';
import { ParakeetModel } from 'parakeet.js';

const MODEL_KEY = 'parakeet-tdt-0.6b-v3';

export class TranscriptionEngine {
  constructor() {
    this._model = null;
  }

  get isLoaded() {
    return this._model !== null;
  }

  /**
   * Load and cache the Parakeet V3 model from Hugging Face.
   * Uses IndexedDB cache so subsequent loads are instant.
   * @param {(msg: string, pct: number) => void} [onProgress]
   */
  async loadModel(onProgress) {
    if (this._model) return;

    const hasWebGPU = typeof navigator !== 'undefined' && navigator.gpu != null;
    const backend = hasWebGPU ? 'webgpu' : 'wasm';
    if (!hasWebGPU) {
      console.warn('[Transcription] WebGPU not available, falling back to WASM');
    }

    onProgress?.('Checking model cache…', 0);

    const modelData = await getParakeetModel(MODEL_KEY, {
      backend,
      encoderQuant: backend === 'webgpu' ? 'fp32' : 'int8',
      decoderQuant: 'int8',
      preprocessorBackend: 'js',
      progress: ({ loaded, total, file }) => {
        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        onProgress?.(`Downloading ${file ?? 'model'}… ${pct}%`, pct, total);
      },
    });

    this._model = await ParakeetModel.fromUrls({
      ...modelData.urls,
      filenames: modelData.filenames,
      backend,
      preprocessorBackend: modelData.preprocessorBackend ?? 'js',
    });

    onProgress?.('Model ready', 100);
  }

  /**
   * Transcribe a single speech segment (from VAD).
   * Input should be 16 kHz mono Float32Array of clean speech (0.5–30 s).
   * @returns {Promise<{ text: string }>}
   */
  async transcribeSegment(float32) {
    if (!this._model) throw new Error('Model not loaded');
    const result = await this._model.transcribeLongAudio(float32, 16000, {
      chunkLengthS: 30,
    });
    return { text: _clean(result.text ?? '') };
  }

  /**
   * Transcribe a complete audio buffer (16 kHz mono Float32Array).
   * Used for file / batch mode.
   * @returns {Promise<{ text: string }>}
   */
  async transcribeFile(float32, onChunk) {
    if (!this._model) throw new Error('Model not loaded');

    const result = await this._model.transcribeLongAudio(float32, 16000, {
      chunkLengthS: 95,
      onChunk: onChunk
        ? (chunk) => onChunk({
            chunkText: _clean(chunk.utterance_text ?? ''),
            fullText: _clean(chunk.text ?? ''),
          })
        : undefined,
    });

    return { text: _clean(result.text ?? '') };
  }

  /**
   * High-quality re-transcription pass with chunk-level timestamps.
   * Used by the hybrid pipeline to re-process recorded session audio
   * and merge two streams chronologically with speaker labels.
   * @param {Float32Array} float32 - 16 kHz mono PCM
   * @param {(chunkText: string) => void} [onChunk]
   * @returns {Promise<{ text: string, chunks: Array<{ text: string, timestamp: [number, number] }> }>}
   */
  async transcribeFileTimestamped(float32, onChunk) {
    if (!this._model) throw new Error('Model not loaded');

    const result = await this._model.transcribeLongAudio(float32, 16000, {
      chunkLengthS: 95,
      returnTimestamps: true,
      onChunk: onChunk
        ? (chunk) => onChunk(_clean(chunk.utterance_text ?? ''))
        : undefined,
    });

    return {
      text:   _clean(result.text ?? ''),
      chunks: result.chunks ?? [],
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip dot/ellipsis noise and trim. */
function _clean(text) {
  return text
    .replace(/(\s*\.\.\.+\s*)+/g, ' ')
    .replace(/(\s*\.\s*){2,}/g, ' ')
    .trim();
}
