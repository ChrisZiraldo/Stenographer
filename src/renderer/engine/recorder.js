/**
 * Framework-agnostic recording engine.
 *
 * Wraps audio capture, energy VAD, Parakeet transcription, WAV encoding,
 * and the rolling-summary scheduling. React components subscribe to events
 * via on/off without touching Web Audio objects directly.
 *
 * Events emitted:
 *   status   (message, state)             — state: 'idle'|'loading'|'recording'|'paused'|'error'
 *   level    (rmsFloat)                   — audio level 0–1
 *   segment  ({ text, speaker })          — live VAD segment transcribed
 *   progress (message)                    — model load / re-transcription progress
 *   error    (message)                    — non-fatal errors
 */

import audioProcessorUrl from '../audio-processor.js?url';
import { TranscriptionEngine } from '../transcription.js';

// ── VAD defaults ──────────────────────────────────────────────────────────────
const SAMPLE_RATE       = 16000;
const FRAME_MS          = 10;
const FRAME_SAMPLES     = (SAMPLE_RATE * FRAME_MS) / 1000;  // 160
const MAX_SPEECH_FRAMES = SAMPLE_RATE * 8 / FRAME_SAMPLES;  // 8 s hard flush

export class Recorder {
  constructor() {
    this._listeners = {};
    this.engine = new TranscriptionEngine();

    // VAD tuning (writeable by EQ panel)
    this.SPEECH_RMS         = 0.018;
    this.SILENCE_RMS        = 0.012;
    this.SMOOTH_ALPHA       = 0.15;
    this.MIN_SPEECH_FRAMES  = 20;
    this.SILENCE_HOLD_FRAMES = 60;

    // Audio graph
    this._audioContext    = null;
    this._mediaStream     = null;
    this._workletNode     = null;
    this._micStream       = null;
    this._micWorklet      = null;
    this._monitorAudio    = null;
    this._passthroughStream = null;

    // Session state
    this.isRecording      = false;
    this.sessionTimestamp = null;

    // Recording buffers
    this.mainRecBuffer    = [];
    this.myRecBuffer      = [];

    // Current transcript plain text
    this.currentTranscript = '';

    // Rolling summary state
    this._lastSummarizedFrameIdx = 0;
    this.prevSummary             = '';
    this._summaryTimer           = null;
    this._isSummarizing          = false;

    // Level meter
    this._currentRmsLevel = 0;
    this._levelRafId      = null;

    // Typing animation serializer
    this._typeChain = Promise.resolve();

    // VAD instances
    this._mainVAD = this._createVAD(null);
    this._myVAD   = this._createVAD('Me');
  }

  // ── Event system ──────────────────────────────────────────────────────────

  on(event, cb) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
  }

  off(event, cb) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((l) => l !== cb);
  }

  _emit(event, ...args) {
    (this._listeners[event] ?? []).forEach((cb) => cb(...args));
  }

  // ── Model loading ──────────────────────────────────────────────────────────

  async loadModel() {
    this._emit('status', 'Loading model…', 'loading');
    let maxPct = 0;
    await this.engine.loadModel((msg, pct, totalBytes) => {
      const BIG_FILE = 50 * 1024 * 1024;
      if (totalBytes > BIG_FILE && pct > maxPct) {
        maxPct = pct;
        this._emit('progress', msg, pct);
      } else {
        this._emit('progress', msg, null);
      }
    });
    this._emit('status', 'Ready — pick devices and hit Go', 'idle');
  }

  // ── Device enumeration ─────────────────────────────────────────────────────

  async enumerateDevices() {
    try {
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000)),
      ]);
      stream?.getTracks?.().forEach((t) => t.stop());
    } catch { /* labels may be empty */ }
    return navigator.mediaDevices.enumerateDevices();
  }

  // ── Recording lifecycle ────────────────────────────────────────────────────

  async start({ inputDeviceId, outputDeviceId, captureMyVoice, liveTx, passthroughOn }) {
    if (!this.sessionTimestamp) {
      this.sessionTimestamp  = this._timestamp();
      this.currentTranscript = '';
      this.mainRecBuffer     = [];
      this.myRecBuffer       = [];
    }

    this._emit('status', 'Starting…', 'loading');
    this._mainVAD = this._createVAD(null);
    this._myVAD   = this._createVAD('Me');
    this._liveTx  = liveTx;

    try {
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      this._emit('status', `Microphone error: ${err.message}`, 'error');
      return;
    }

    this._audioContext = new AudioContext();
    await this._audioContext.audioWorklet.addModule(audioProcessorUrl);
    const source = this._audioContext.createMediaStreamSource(this._mediaStream);
    this._workletNode = new AudioWorkletNode(this._audioContext, 'audio-downsample-processor');

    this._workletNode.port.onmessage = (e) => {
      if (e.data.type !== 'frame') return;
      const frame = e.data.data;
      this.mainRecBuffer.push(frame);
      this._currentRmsLevel = this._rms(frame);
      if (this._liveTx) this._onAudioFrame(frame, this._mainVAD);
    };

    source.connect(this._workletNode);
    const silentGain = this._audioContext.createGain();
    silentGain.gain.value = 0;
    this._workletNode.connect(silentGain);
    silentGain.connect(this._audioContext.destination);

    // Optional second mic stream
    if (captureMyVoice) {
      try {
        const micId = outputDeviceId; // reuse the mic selector value passed in
        this._micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: micId ? { exact: micId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        const micSource = this._audioContext.createMediaStreamSource(this._micStream);
        this._micWorklet = new AudioWorkletNode(this._audioContext, 'audio-downsample-processor');
        this._micWorklet.port.onmessage = (e) => {
          if (e.data.type !== 'frame') return;
          this.myRecBuffer.push(e.data.data);
          if (this._liveTx) this._onAudioFrame(e.data.data, this._myVAD);
        };
        micSource.connect(this._micWorklet);
        const micGain = this._audioContext.createGain();
        micGain.gain.value = 0;
        this._micWorklet.connect(micGain);
        micGain.connect(this._audioContext.destination);
      } catch (err) {
        console.warn('[Recorder] Mic capture failed:', err.message);
      }
    }

    this.isRecording = true;
    this._startLevelMeter();
    this._emit('status', 'Listening…', 'recording');
  }

  async pause() {
    if (!this.isRecording) return;
    this._stopLevelMeter();
    this._emit('status', 'Pausing…', 'loading');

    this._workletNode?.disconnect();
    this._micWorklet?.disconnect();
    this._mediaStream?.getTracks().forEach((t) => t.stop());
    this._micStream?.getTracks().forEach((t) => t.stop());
    this._micStream  = null;
    this._micWorklet = null;

    await this._audioContext?.close();

    // Flush remaining VAD speech
    const flushJobs = [this._mainVAD, this._myVAD]
      .filter((v) => v.buffer.length > 0 && v.speechFrames >= this.MIN_SPEECH_FRAMES)
      .map((v) => this._flushSegment(v));
    await Promise.all(flushJobs);

    this.isRecording = false;

    // Auto-save WAV on pause
    if (this.mainRecBuffer.length > 0 && this.sessionTimestamp) {
      const mainPcm = this._concatFrames(this.mainRecBuffer);
      const hasMic  = this.myRecBuffer.length > 0;
      const mixed   = hasMic ? this._mixBuffers(mainPcm, this._concatFrames(this.myRecBuffer)) : mainPcm;
      const wav     = this._encodeWav(mixed);
      window.api.saveAudio({
        bytes:    Array.from(wav),
        filePath: `recordings/${this.sessionTimestamp}/recording.wav`,
      }).catch((e) => console.warn('[Recorder] WAV save failed:', e));
    }

    const hasContent = this.currentTranscript.trim() || this.mainRecBuffer.length >= 1000;
    this._emit('status',
      hasContent ? 'Paused — hit Go to resume or Enhance Notes when done' : 'Ready — pick devices and hit Go',
      hasContent ? 'paused' : 'idle'
    );
  }

  resetSession() {
    if (this.isRecording) return;
    clearTimeout(this._summaryTimer);
    this._isSummarizing          = false;
    this._lastSummarizedFrameIdx = 0;
    this.prevSummary             = '';
    this.sessionTimestamp        = null;
    this.currentTranscript       = '';
    this.mainRecBuffer           = [];
    this.myRecBuffer             = [];
    this._typeChain              = Promise.resolve();
    this._emit('status', 'Ready — pick devices and hit Go', 'idle');
  }

  // ── Passthrough ────────────────────────────────────────────────────────────

  async startPassthrough(inputDeviceId, outputDeviceId) {
    this.stopPassthrough();
    try {
      this._passthroughStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this._monitorAudio = new Audio();
      this._monitorAudio.srcObject = this._passthroughStream;
      this._monitorAudio.muted = false;
      if (outputDeviceId && this._monitorAudio.setSinkId) {
        await this._monitorAudio.setSinkId(outputDeviceId).catch(() => {});
      }
      await this._monitorAudio.play();
    } catch (err) {
      console.warn('[Recorder] Passthrough failed:', err.message);
    }
  }

  stopPassthrough() {
    if (this._monitorAudio) {
      this._monitorAudio.pause();
      this._monitorAudio.srcObject = null;
      this._monitorAudio = null;
    }
    this._passthroughStream?.getTracks().forEach((t) => t.stop());
    this._passthroughStream = null;
  }

  // ── High-quality re-transcription (for "Enhance" / "Generate Notes") ────────

  async enhanceTranscript() {
    if (this.mainRecBuffer.length === 0) return false;

    this._emit('status', 'Re-processing audio for higher accuracy…', 'loading');
    const mainPcm = this._concatFrames(this.mainRecBuffer);
    const hasMic  = this.myRecBuffer.length > 0;
    const myPcm   = hasMic ? this._concatFrames(this.myRecBuffer) : null;
    const previous = this.currentTranscript;

    this.currentTranscript = '';
    this._emit('transcript', '');

    let mainChunks = [];
    let myChunks   = [];

    try {
      const mainResult = await this.engine.transcribeFileTimestamped(mainPcm, (chunkText) => {
        if (!chunkText.trim()) return;
        this.currentTranscript += (this.currentTranscript ? ' ' : '') + chunkText.trim();
        this._emit('transcript', this.currentTranscript);
        this._emit('status', `Re-processing… ${chunkText.trim().slice(0, 50)}…`, 'loading');
      });
      mainChunks = (mainResult.chunks ?? []).map((c) => ({ ...c, speaker: null }));

      if (!this.currentTranscript.trim()) {
        const fallback = mainChunks.filter((c) => c.text?.trim()).map((c) => c.text.trim()).join(' ')
          || mainResult.text?.trim() || '';
        if (fallback) {
          this.currentTranscript = fallback;
          this._emit('transcript', this.currentTranscript);
        }
      }
    } catch (err) {
      console.error('[Recorder] Enhance main failed:', err);
      this.currentTranscript = previous;
      this._emit('transcript', this.currentTranscript);
      this._emit('status', 'Re-processing failed — using prior transcript.', 'paused');
      return false;
    }

    if (hasMic) {
      try {
        const myResult = await this.engine.transcribeFileTimestamped(myPcm);
        myChunks = (myResult.chunks ?? []).map((c) => ({ ...c, speaker: 'Me' }));
      } catch { /* ignore */ }

      if (myChunks.length > 0) {
        const allChunks = [...mainChunks, ...myChunks]
          .filter((c) => c.text?.trim())
          .sort((a, b) => (a.timestamp?.[0] ?? 0) - (b.timestamp?.[0] ?? 0));
        this.currentTranscript = allChunks
          .map((c) => (c.speaker ? `[${c.speaker}] ${c.text.trim()}` : c.text.trim()))
          .join(' ');
        this._emit('transcript', this.currentTranscript);
      }
    }

    if (!this.currentTranscript.trim()) {
      this.currentTranscript = previous;
      this._emit('transcript', this.currentTranscript);
      return false;
    }

    this._emit('status', 'Re-processing complete.', 'paused');
    return true;
  }

  /** Transcribe an imported audio file */
  async transcribeFile(file) {
    const { decodeAudioFile } = await import('../file-import.js');
    this._emit('status', `Decoding ${file.name}…`, 'loading');
    let pcm;
    try {
      pcm = await decodeAudioFile(file, (pct) => {
        this._emit('status', `Decoding ${file.name}… ${pct}%`, 'loading');
      });
    } catch (err) {
      this._emit('status', `Failed to decode: ${err.message}`, 'error');
      throw err;
    }

    this._emit('status', `Transcribing ${file.name}…`, 'loading');
    const result = await this.engine.transcribeFile(pcm, ({ chunkText }) => {
      if (chunkText.trim()) {
        this._typeChain = this._typeChain.then(() => this._typeInSegment(chunkText));
      }
    });
    await this._typeChain;

    if (!this.currentTranscript.trim() && result?.text?.trim()) {
      await this._typeInSegment(result.text);
    }
    return this.currentTranscript;
  }

  /** Encode current recording buffers to WAV bytes */
  getWavBytes() {
    if (this.mainRecBuffer.length === 0) return null;
    const mainPcm = this._concatFrames(this.mainRecBuffer);
    const hasMic  = this.myRecBuffer.length > 0;
    const mixed   = hasMic ? this._mixBuffers(mainPcm, this._concatFrames(this.myRecBuffer)) : mainPcm;
    return Array.from(this._encodeWav(mixed));
  }

  // ── Rolling summary ────────────────────────────────────────────────────────

  scheduleRollingSummary({ intervalSecs, meetingId }) {
    clearTimeout(this._summaryTimer);
    if (!this.isRecording) return null;
    // Store so _runRollingSummary can reschedule itself
    this._summaryIntervalSecs = intervalSecs;
    this._summaryMeetingId    = meetingId;
    const delayMs = Math.max(10, intervalSecs) * 1_000;
    this._summaryTimer = setTimeout(() => {
      this._runRollingSummary({ meetingId }).catch(console.warn);
    }, delayMs);
    return Date.now() + delayMs;
  }

  async _runRollingSummary({ meetingId }) {
    if (!this.isRecording || this._isSummarizing) {
      this._rescheduleRollingSummary();
      return;
    }
    const newFrames = this.mainRecBuffer.slice(this._lastSummarizedFrameIdx);
    if (newFrames.length < 100 * 10) {
      this._rescheduleRollingSummary();
      return;
    }

    this._isSummarizing = true;
    this._lastSummarizedFrameIdx = this.mainRecBuffer.length;
    this._emit('summary-state', 'Transcribing…');

    let deltaText = '';
    try {
      const deltaPcm = this._concatFrames(newFrames);
      const result = await this.engine.transcribeFileTimestamped(deltaPcm);
      deltaText = (result.chunks ?? []).filter((c) => c.text?.trim()).map((c) => c.text.trim()).join(' ');
    } catch {
      this._isSummarizing = false;
      this._emit('summary-state', '');
      this._rescheduleRollingSummary();
      return;
    }

    if (!deltaText.trim()) {
      this._isSummarizing = false;
      this._emit('summary-state', '');
      this._rescheduleRollingSummary();
      return;
    }

    this._emit('summary-state', 'Summarising…');
    let accumulated = '';

    window.api.onSummaryChunk((text) => {
      accumulated += text;
      this._emit('summary-chunk', accumulated);
    });

    try {
      await window.api.generateSummary({ prevSummary: this.prevSummary, deltaText, meetingId });
      this.prevSummary = accumulated;
    } catch { /* ignore */ } finally {
      window.api.offSummaryChunk();
      this._isSummarizing = false;
      this._emit('summary-state', '');
      this._rescheduleRollingSummary();
    }
  }

  _rescheduleRollingSummary() {
    if (this.isRecording && this._summaryIntervalSecs && this._summaryMeetingId) {
      this.scheduleRollingSummary({
        intervalSecs: this._summaryIntervalSecs,
        meetingId:    this._summaryMeetingId,
      });
    }
  }

  // ── VAD internals ──────────────────────────────────────────────────────────

  _createVAD(label) {
    return { label, state: 'silence', smoothedRms: 0, speechFrames: 0, silenceFrames: 0, buffer: [], flushing: false };
  }

  _rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }

  _onAudioFrame(frame, vad) {
    vad.smoothedRms = this.SMOOTH_ALPHA * this._rms(frame) + (1 - this.SMOOTH_ALPHA) * vad.smoothedRms;
    if (vad.state === 'silence') {
      if (vad.smoothedRms > this.SPEECH_RMS) {
        vad.state = 'speaking';
        vad.speechFrames = 1;
        vad.silenceFrames = 0;
        vad.buffer.push(frame);
        this._emit('speaking');
      }
    } else {
      vad.buffer.push(frame);
      if (vad.smoothedRms > this.SPEECH_RMS) {
        vad.speechFrames++;
        vad.silenceFrames = 0;
      } else {
        vad.silenceFrames++;
        if (vad.silenceFrames >= this.SILENCE_HOLD_FRAMES && vad.speechFrames >= this.MIN_SPEECH_FRAMES) {
          this._flushSegment(vad);
          return;
        }
      }
      if (vad.buffer.length >= MAX_SPEECH_FRAMES) this._flushSegment(vad);
    }
  }

  async _flushSegment(vad) {
    if (vad.flushing) return;
    vad.flushing = true;
    const frames = vad.buffer;
    vad.buffer = [];
    vad.state = 'silence';
    vad.smoothedRms = 0;
    vad.speechFrames = 0;
    vad.silenceFrames = 0;

    const total = frames.reduce((n, f) => n + f.length, 0);
    const audio = new Float32Array(total);
    let off = 0;
    for (const f of frames) { audio.set(f, off); off += f.length; }

    this._emit('transcribing');

    let text = '';
    try {
      ({ text } = await this.engine.transcribeSegment(audio));
    } catch (err) {
      console.error('[VAD] Transcription error:', err);
      this._emit('error', err.message);
    }

    vad.flushing = false;

    if (text) {
      this._typeChain = this._typeChain.then(() => this._typeInSegment(text, vad.label));
    }
  }

  async _typeInSegment(text, speakerLabel = null) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;

    const base = this.currentTranscript;
    for (let i = 0; i < words.length; i++) {
      const partial = words.slice(0, i + 1).join(' ');
      this._emit('typing', { partial, speakerLabel, base });
      await new Promise((r) => setTimeout(r, 38));
    }

    const labelPlain = speakerLabel ? `[${speakerLabel}] ` : '';
    const plainSegment = labelPlain + text.trim();
    this.currentTranscript = base + (base ? ' ' : '') + plainSegment;
    this._emit('segment', { text: text.trim(), speaker: speakerLabel });
    this._emit('transcript', this.currentTranscript);

    // Auto-save transcript
    if (this.sessionTimestamp) {
      clearTimeout(this._autoSaveTimer);
      this._autoSaveTimer = setTimeout(() => {
        window.api.saveTranscript({
          text: this.currentTranscript,
          filePath: `recordings/${this.sessionTimestamp}/transcript.txt`,
        });
      }, 2000);
    }
  }

  // ── Level meter ────────────────────────────────────────────────────────────

  _startLevelMeter() {
    if (this._levelRafId) return;
    const tick = () => {
      this._emit('level', Math.min(1, this._currentRmsLevel / 0.05));
      this._levelRafId = requestAnimationFrame(tick);
    };
    this._levelRafId = requestAnimationFrame(tick);
  }

  _stopLevelMeter() {
    if (this._levelRafId) { cancelAnimationFrame(this._levelRafId); this._levelRafId = null; }
    this._emit('level', 0);
  }

  // ── Audio helpers ──────────────────────────────────────────────────────────

  _concatFrames(frames) {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const f of frames) { out.set(f, off); off += f.length; }
    return out;
  }

  _mixBuffers(a, b) {
    const len = Math.max(a.length, b.length);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const s = (i < a.length ? a[i] : 0) + (i < b.length ? b[i] : 0);
      out[i] = Math.max(-1, Math.min(1, s));
    }
    return out;
  }

  _encodeWav(float32, sampleRate = 16000) {
    const numSamples = float32.length;
    const bytesPerSample = 2;
    const dataSize = numSamples * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Uint8Array(buffer);
  }

  _timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  // ── Dictation mode (push-to-talk → editor, bypasses the full recording pipeline) ──
  // Tap to start: mic opens and all audio is buffered.
  // Tap to stop: Parakeet transcribes the full buffer and the text is returned.

  get isDictating() { return !!this._dictationStream; }

  async startDictation() {
    if (this._dictationStream) return true;

    console.log('[Dictation] starting, model loaded:', this.engine.isLoaded);
    if (!this.engine.isLoaded) {
      console.warn('[Dictation] Parakeet model not loaded — open a note and wait for the model to initialise first');
      return false;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.error('[Dictation] mic error:', err.message);
      return false;
    }

    console.log('[Dictation] mic stream open, setting up AudioContext');
    const ctx    = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    console.log('[Dictation] AudioContext state:', ctx.state);

    const frames = [];

    await ctx.audioWorklet.addModule(audioProcessorUrl);
    const source  = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'audio-downsample-processor');

    let frameCount = 0;
    worklet.port.onmessage = (e) => {
      if (e.data.type === 'frame') {
        frames.push(e.data.data);
        frameCount++;
        if (frameCount === 1) console.log('[Dictation] first frame received, data type:', e.data.data?.constructor?.name, 'length:', e.data.data?.length);
      }
    };

    worklet.port.onerror = (e) => console.error('[Dictation] worklet port error:', e);

    source.connect(worklet);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    worklet.connect(sink);
    sink.connect(ctx.destination);

    console.log('[Dictation] audio graph ready, listening…');
    this._dictationStream  = stream;
    this._dictationContext = ctx;
    this._dictationWorklet = worklet;
    this._dictationFrames  = frames;
    return true;
  }

  async stopDictation() {
    if (!this._dictationStream) return null;

    const frames = this._dictationFrames ?? [];
    console.log('[Dictation] stopping, frames collected:', frames.length);

    try { this._dictationWorklet?.port.close(); } catch {}
    try { this._dictationWorklet?.disconnect(); } catch {}
    try { this._dictationContext?.close(); } catch {}
    this._dictationStream?.getTracks?.().forEach((t) => t.stop());
    this._dictationStream  = null;
    this._dictationContext = null;
    this._dictationWorklet = null;
    this._dictationFrames  = null;

    if (!frames.length) {
      console.warn('[Dictation] no frames captured — audio worklet may not have fired');
      return null;
    }

    const audio = this._concatFrames(frames);
    console.log('[Dictation] transcribing', audio.length, 'samples (', (audio.length / 16000).toFixed(1), 's)');
    try {
      const { text } = await this.engine.transcribeSegment(audio);
      console.log('[Dictation] transcription result:', JSON.stringify(text));
      return text?.trim() || null;
    } catch (err) {
      console.error('[Recorder] Dictation transcription error:', err);
      return null;
    }
  }
}

// Singleton for the renderer
export const recorder = new Recorder();
