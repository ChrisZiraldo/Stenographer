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
// ~3 hours at 160 samples/frame, 100 fps → warn if recording grows unbounded. [R17]
const MAX_REC_BUFFER_FRAMES = (SAMPLE_RATE * 3 * 3600) / FRAME_SAMPLES;

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
    this._audioContext = null;
    this._mediaStream  = null;
    this._workletNode  = null;
    this._micStream    = null;
    this._micWorklet   = null;
    this._starting     = false; // [R15] true while start() is setting up audio graph

    // Session state
    this.isRecording      = false;
    this.sessionTimestamp = null;
    this.activeMeetingId  = null;

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

    // Inference mutex: serialize all calls to engine.transcribeSegment / transcribeFileTimestamped
    // so VAD flushes and dictation don't race on the model.
    this._inferenceChain = Promise.resolve();

    // Deduplication guard for loadModel (cleared on failure to allow retry)
    this._loadModelPromise = null;

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
    if (this._loadModelPromise) return this._loadModelPromise;
    this._emit('status', 'Loading model…', 'loading');
    let maxPct = 0;
    this._loadModelPromise = this.engine.loadModel((msg, pct, totalBytes) => {
      const BIG_FILE = 50 * 1024 * 1024;
      if (totalBytes > BIG_FILE && pct > maxPct) {
        maxPct = pct;
        this._emit('progress', msg, pct);
      } else {
        this._emit('progress', msg, null);
      }
    }).then(() => {
      this._emit('status', 'Ready', 'idle');
    }).catch((err) => {
      this._loadModelPromise = null; // allow retry
      this._emit('error', `Model load failed: ${err.message}`);
      this._emit('status', `Model load failed: ${err.message}`, 'idle');
      throw err;
    });
    return this._loadModelPromise;
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

  /**
   * Obtain system audio loopback via Electron's desktopCapturer.
   * On macOS 14.2+ this is backed by the CoreAudio Tap API.
   * The video track is stopped immediately — we only need the audio.
   */
  async _getLoopbackStream() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      throw new Error('No audio track in loopback stream — ensure system audio capture is permitted');
    }
    return stream;
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.loopbackEnabled  – capture call/system audio via loopback
   * @param {boolean} opts.micEnabled       – capture microphone
   * @param {string}  opts.micDeviceId      – specific mic device (optional)
   * @param {boolean} opts.liveTx           – emit live VAD segments
   */
  async start({ loopbackEnabled, micEnabled, micDeviceId, liveTx, meetingId }) {
    // Re-entry guard: prevent double-start or starting while dictation is active
    if (this.isRecording || this._audioContext || this._dictationStream || this._starting) return;
    this._starting = true; // [R15] block pause() while setup is in progress

    if (!loopbackEnabled && !micEnabled) {
      this._starting = false;
      this._emit('status', 'Enable at least one audio source in Settings.', 'error');
      return;
    }

    if (meetingId) this.activeMeetingId = meetingId;

    if (!this.sessionTimestamp) {
      this.sessionTimestamp  = this._timestamp();
      this.currentTranscript = '';
      this.mainRecBuffer     = [];
      this.myRecBuffer       = [];
    }

    this._emit('status', 'Starting…', 'loading');
    this._liveTx = liveTx;

    // When both sources are active, label the mic stream [Me].
    // When mic is the only source (in-person), speaker = null (no label).
    const micSpeakerLabel = loopbackEnabled ? 'Me' : null;

    this._mainVAD = this._createVAD(null);
    this._myVAD   = this._createVAD(micSpeakerLabel);

    // Wrap all audio-graph setup in try/catch so any failure nulls _audioContext
    // and resets state — otherwise the re-entry guard bricks future start() calls. [R8]
    try {
      this._audioContext = new AudioContext();
      if (this._audioContext.state !== 'running') {
        await this._audioContext.resume();
      }
      await this._audioContext.audioWorklet.addModule(audioProcessorUrl);
    } catch (err) {
      this._starting = false;
      await this._audioContext?.close().catch(() => {});
      this._audioContext = null;
      this._emit('status', `Audio setup failed: ${err.message}`, 'error');
      return;
    }

    // ── Main stream: loopback (remote call) or mic (in-person) ───────────────
    if (loopbackEnabled) {
      try {
        this._mediaStream = await this._getLoopbackStream();
      } catch (err) {
        this._starting = false;
        await this._audioContext.close();
        this._audioContext = null;
        this._emit('status',
          'Call audio capture was denied. Enable "Screen & System Audio Recording" in System Settings → Privacy.',
          'error'
        );
        return;
      }
    } else {
      // Mic-only (in-person meeting) — route through the main pipeline
      try {
        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch (err) {
        this._starting = false;
        await this._audioContext.close();
        this._audioContext = null;
        this._emit('status', `Microphone error: ${err.message}`, 'error');
        return;
      }
    }

    const source = this._audioContext.createMediaStreamSource(this._mediaStream);
    this._workletNode = new AudioWorkletNode(this._audioContext, 'audio-downsample-processor');
    this._workletNode.port.onmessage = (e) => {
      if (e.data.type !== 'frame') return;
      const frame = e.data.data;
      this.mainRecBuffer.push(frame);
      // [R17] Warn if the recording buffer grows beyond the max duration cap
      if (this.mainRecBuffer.length === MAX_REC_BUFFER_FRAMES) {
        console.warn('[Recorder] recording buffer exceeds 3-hour cap; oldest frames will be dropped on WAV encode');
      }
      this._currentRmsLevel = this._rms(frame);
      if (this._liveTx) this._onAudioFrame(frame, this._mainVAD);
    };
    source.connect(this._workletNode);
    const silentGain = this._audioContext.createGain();
    silentGain.gain.value = 0;
    this._workletNode.connect(silentGain);
    silentGain.connect(this._audioContext.destination);

    // ── Mic stream: only when loopback is also active (labels voice as [Me]) ──
    if (loopbackEnabled && micEnabled) {
      try {
        this._micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
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

    this._starting = false; // [R15] clear setup flag before marking live
    this.isRecording = true;
    this._startLevelMeter();
    this._emit('status', 'Listening…', 'recording');
  }

  async pause() {
    // Defer if start() is still setting up the audio graph. [R15]
    if (this._starting) {
      console.warn('[Recorder] pause() called while start() is in progress — deferring');
      return;
    }
    if (!this.isRecording) return;
    this._stopLevelMeter();
    clearTimeout(this._summaryTimer); // [R14] stop rolling summary timer on pause
    this._emit('status', 'Pausing…', 'loading');

    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._micWorklet) {
      this._micWorklet.port.onmessage = null;
      this._micWorklet.disconnect();
      this._micWorklet = null;
    }
    this._mediaStream?.getTracks().forEach((t) => t.stop());
    this._mediaStream = null;
    this._micStream?.getTracks().forEach((t) => t.stop());
    this._micStream = null;

    await this._audioContext?.close();
    this._audioContext = null;

    // Flush remaining VAD speech (including short buffers below MIN_SPEECH_FRAMES
    // so last few words aren't silently dropped at the end of a recording). [R10]
    // Then drain the full inference chain so enhanceTranscript (called next by the
    // caller) doesn't overlap in-flight transcriptions. [R5]
    const flushJobs = [this._mainVAD, this._myVAD]
      .filter((v) => v.buffer.length > 0)
      .map((v) => this._flushSegment(v));
    await Promise.all(flushJobs);
    // Drain any inference still running (the flush schedules work on _inferenceChain)
    await this._inferenceChain;

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
      hasContent ? 'Paused — hit Record to resume or Generate when done' : 'Ready',
      hasContent ? 'paused' : 'idle'
    );
  }

  resetSession() {
    if (this.isRecording) return;
    clearTimeout(this._summaryTimer);
    clearTimeout(this._autoSaveTimer);  // [R11] clear auto-save timer
    this._isSummarizing          = false;
    this._lastSummarizedFrameIdx = 0;
    this.prevSummary             = '';
    this.sessionTimestamp        = null;
    this.currentTranscript       = '';
    this.activeMeetingId         = null;
    this.mainRecBuffer           = [];
    this.myRecBuffer             = [];
    this._typeChain              = Promise.resolve();
    this._inferenceChain         = Promise.resolve();  // [R11] reset inference mutex
    this._emit('status', 'Ready', 'idle');
  }

  // ── High-quality re-transcription (for "Generate Notes") ────────────────────

  async enhanceTranscript() {
    // Guard: don't run while actively recording — the buffers are still growing.
    // Callers should pause first. Snapshot buffers at entry to be safe.
    if (this.isRecording) return false;
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

    // Route through the inference mutex so enhanceTranscript never races with
    // live VAD flushes or dictation that may still be draining. [R1]
    try {
      let mainResult;
      await (this._inferenceChain = this._inferenceChain.then(() =>
        this.engine.transcribeFileTimestamped(mainPcm, (chunkText) => {
          if (!chunkText.trim()) return;
          this.currentTranscript += (this.currentTranscript ? ' ' : '') + chunkText.trim();
          this._emit('transcript', this.currentTranscript);
          this._emit('status', `Re-processing… ${chunkText.trim().slice(0, 50)}…`, 'loading');
        }).then((r) => { mainResult = r; })
      ));
      mainChunks = (mainResult?.chunks ?? []).map((c) => ({ ...c, speaker: null }));

      if (!this.currentTranscript.trim()) {
        const fallback = mainChunks.filter((c) => c.text?.trim()).map((c) => c.text.trim()).join(' ')
          || mainResult.text?.trim() || '';
        if (fallback) {
          this.currentTranscript = fallback;
          this._emit('transcript', this.currentTranscript);
        }
      }
    } catch (err) {
      console.error('[Recorder] Generate main failed:', err);
      this.currentTranscript = previous;
      this._emit('transcript', this.currentTranscript);
      this._emit('status', 'Re-processing failed — using prior transcript.', 'paused');
      return false;
    }

    if (hasMic) {
      try {
        let myResult;
        await (this._inferenceChain = this._inferenceChain.then(() =>
          this.engine.transcribeFileTimestamped(myPcm).then((r) => { myResult = r; })
        ));
        // The mic and loopback streams are started at slightly different times.
        // Estimate mic-start delay: myPcm may be shorter than mainPcm by the delta.
        const mainDurationS = mainPcm.length / SAMPLE_RATE;
        const micDurationS  = myPcm.length / SAMPLE_RATE;
        const micDelayS = Math.max(0, mainDurationS - micDurationS);
        // Offset all mic chunk timestamps by the measured delay so they sort correctly.
        myChunks = (myResult?.chunks ?? []).map((c) => ({
          ...c,
          speaker: 'Me',
          timestamp: c.timestamp
            ? [c.timestamp[0] + micDelayS, c.timestamp[1] + micDelayS]
            : c.timestamp,
        }));
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

    // Return the merged chunk list so callers can persist per-chunk timestamps.
    if (hasMic && myChunks.length > 0) {
      return [...mainChunks, ...myChunks]
        .filter((c) => c.text?.trim())
        .sort((a, b) => (a.timestamp?.[0] ?? 0) - (b.timestamp?.[0] ?? 0));
    }
    return mainChunks.filter((c) => c.text?.trim());
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

    // Ensure model is loaded before transcribing (cold-start safety). [R12]
    await this.loadModel();

    // Reset typing animation chain so import doesn't overlap a live session. [R13]
    this._typeChain = Promise.resolve();

    this._emit('status', `Transcribing ${file.name}…`, 'loading');
    // Route through inference mutex so file import doesn't race VAD flushes. [R4]
    let result;
    await (this._inferenceChain = this._inferenceChain.then(() =>
      this.engine.transcribeFile(pcm, ({ chunkText }) => {
        if (chunkText.trim()) {
          this._typeChain = this._typeChain.then(() => this._typeInSegment(chunkText));
        }
      }).then((r) => { result = r; })
    ));
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
    const snapshotIdx = this.mainRecBuffer.length;
    const newFrames = this.mainRecBuffer.slice(this._lastSummarizedFrameIdx);
    if (newFrames.length < 100 * 10) {
      this._rescheduleRollingSummary();
      return;
    }

    this._isSummarizing = true;
    this._emit('summary-state', 'Transcribing…');

    let deltaText = '';
    try {
      const deltaPcm = this._concatFrames(newFrames);
      // Route through inference mutex so summary doesn't race live VAD flushes. [R2]
      let result;
      await (this._inferenceChain = this._inferenceChain.then(() =>
        this.engine.transcribeFileTimestamped(deltaPcm).then((r) => { result = r; })
      ));
      deltaText = (result?.chunks ?? []).filter((c) => c.text?.trim()).map((c) => c.text.trim()).join(' ');
    } catch {
      this._isSummarizing = false;
      this._emit('summary-state', '');
      this._rescheduleRollingSummary();
      return;
    }

    // Cooperative abort: bail if recording stopped while we were transcribing
    if (!this.isRecording) {
      this._isSummarizing = false;
      this._emit('summary-state', '');
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
      const res = await window.api.generateSummary({ prevSummary: this.prevSummary, deltaText, meetingId });
      // Cooperative abort check after async IPC
      if (!this.isRecording) return;
      if (res?.ok) {
        // Advance frame index only on success so we don't skip audio on failure
        this._lastSummarizedFrameIdx = snapshotIdx;
        this.prevSummary = accumulated;
      }
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
    if (!frame?.length) return 0; // [R16] guard divide-by-zero on empty frame
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
      // Use SILENCE_RMS (< SPEECH_RMS) as the exit threshold for hysteresis:
      // once speaking, keep speaking until volume drops below the lower level. [R9]
      if (vad.smoothedRms > this.SILENCE_RMS) {
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

    // Serialize inference through the mutex so concurrent VAD flushes (main + mic)
    // don't call the model simultaneously and corrupt its internal state.
    let text = '';
    this._inferenceChain = this._inferenceChain.then(async () => {
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
    }).catch((err) => {
      vad.flushing = false;
      console.error('[VAD] Inference chain error:', err);
    });
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

    // Auto-save transcript (debounced)
    if (this.sessionTimestamp) {
      clearTimeout(this._autoSaveTimer);
      this._autoSaveTimer = setTimeout(() => {
        window.api.saveTranscript({
          text: this.currentTranscript,
          filePath: `recordings/${this.sessionTimestamp}/transcript.txt`,
        }).then((res) => {
          if (!res?.ok) console.warn('[Recorder] saveTranscript failed:', res?.error);
        }).catch((err) => console.warn('[Recorder] saveTranscript error:', err));
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

    // Mutual exclusion: refuse dictation while recording is active
    if (this.isRecording) {
      console.warn('[Dictation] Cannot start dictation while recording is in progress');
      return false;
    }

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

    // Give the worklet a brief window to flush any last frames before teardown. [R6]
    await new Promise((r) => setTimeout(r, 50));

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
      // Route through inference mutex so dictation doesn't race live VAD flushes. [R3]
      let text = null;
      await (this._inferenceChain = this._inferenceChain.then(async () => {
        const result = await this.engine.transcribeSegment(audio);
        text = result.text;
      }));
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
