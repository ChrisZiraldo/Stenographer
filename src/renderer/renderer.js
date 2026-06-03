/**
 * Main renderer — audio capture + energy VAD + Parakeet transcription.
 *
 * VAD strategy (energy-based, no external library):
 *   - AudioWorklet sends 10 ms frames at 16 kHz
 *   - Smoothed RMS tracks energy per frame
 *   - State machine: SILENCE → SPEECH → SILENCE
 *   - On SPEECH→SILENCE after ≥ 400 ms of speech and ≥ 500 ms of silence,
 *     flush the accumulated audio buffer to Parakeet
 *   - Hard flush if buffer exceeds MAX_SPEECH_S (avoid GPU memory issues)
 */

import audioProcessorUrl from './audio-processor.js?url';
import { TranscriptionEngine } from './transcription.js';
import { decodeAudioFile, setupDropZone } from './file-import.js';

// ── VAD constants ─────────────────────────────────────────────────────────────
const SAMPLE_RATE       = 16000;
const FRAME_MS          = 10;
const FRAME_SAMPLES     = (SAMPLE_RATE * FRAME_MS) / 1000;  // 160

// RMS thresholds — all overwritten at runtime by the EQ flyout sliders.
let SPEECH_RMS          = 0.018;   // enter SPEAKING when smoothed RMS exceeds this
let SILENCE_RMS         = 0.012;   // return to SILENCE when smoothed RMS drops below this
let SMOOTH_ALPHA        = 0.15;    // EMA coefficient (lower = smoother)
let MIN_SPEECH_FRAMES   = 20;      // ≥ 200 ms of speech before we consider it real
let SILENCE_HOLD_FRAMES = 60;      // ≥ 600 ms of silence before segment ends
const MAX_SPEECH_FRAMES  = SAMPLE_RATE * 8 / FRAME_SAMPLES;   // hard flush at 8 s (keeps latency low)

// ── State ─────────────────────────────────────────────────────────────────────
const engine = new TranscriptionEngine();
let isRecording   = false;
let audioContext  = null;
let mediaStream   = null;
let workletNode   = null;
let monitorAudio  = null;
let micStream     = null;   // second stream for "capture me" mic (no pass-through)
let micWorklet    = null;
let currentTranscript = '';
let sessionTimestamp  = null;

// Each audio source gets its own VAD instance so they don't share state.
function createVAD(label = null) {
  return { label, state: 'silence', smoothedRms: 0, speechFrames: 0, silenceFrames: 0, buffer: [], flushing: false };
}
let mainVAD = createVAD(null);   // call audio / BlackHole
let myVAD   = createVAD('Me');   // user's microphone

// ── Session recording buffers (hybrid re-transcription) ───────────────────────
// Accumulate raw 16 kHz mono Float32 frames during recording so we can
// run a higher-quality full-context pass after the session ends.
let mainRecBuffer = [];   // frames from the main stream (BlackHole / input device)
let myRecBuffer   = [];   // frames from the mic stream (only when "Include my voice" is on)

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const goBtn         = $('go-btn');
const notesBtn      = $('notes-btn');
const clearBtn      = $('clear-btn');
const statusEl      = $('status');
const subtitleEl    = $('subtitle');
const transcriptEl  = $('transcript');
const inputSel      = $('input-device');
const outputSel     = $('output-device');
const passthroughCb  = $('passthrough');
const captureMicCb    = $('capture-mic');
const captureMicGroup = $('capture-mic-group');
const micSel          = $('mic-device');
const eqBtn          = $('eq-btn');
const eqPanel       = $('eq-panel');
const eqClose       = $('eq-close');
const notesStatus   = $('notes-status');
const fileBtn       = $('file-btn');
const fileInput     = $('file-input');
const dropOverlay   = $('drop-overlay');

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  setStatus('Loading model…', 'loading');
  enumerateDevices().catch(() => {});
  await loadModel();

  setupDropZone(document.body, handleFile);

  goBtn.addEventListener('click', toggleRecording);
  notesBtn.addEventListener('click', generateNotesHandler);
  clearBtn.addEventListener('click', newSession);
  passthroughCb.addEventListener('change', onPassthroughToggle);
  onPassthroughToggle();
  captureMicCb.addEventListener('change', onCaptureMicToggle);
  onCaptureMicToggle();

  // EQ flyout
  eqBtn.addEventListener('click', () => toggleEqPanel());
  eqClose.addEventListener('click', () => toggleEqPanel(false));
  ['eq-sensitivity', 'eq-reactivity', 'eq-minspeech', 'eq-silence'].forEach((id) => {
    const el = $(id);
    el.addEventListener('input', () => onEqChange(id, el));
    onEqChange(id, el);
  });
  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });

  document.addEventListener('dragenter', () => dropOverlay?.classList.add('visible'));
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) dropOverlay?.classList.remove('visible');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay?.classList.remove('visible');
  });
}

// ── Device enumeration ────────────────────────────────────────────────────────

async function enumerateDevices() {
  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    if (stream?.getTracks) stream.getTracks().forEach((t) => t.stop());
  } catch { /* permission denied or timeout — labels may be empty */ }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs  = devices.filter((d) => d.kind === 'audioinput');
  populateSelect(inputSel,  inputs, 'BlackHole');
  populateSelect(outputSel, devices.filter((d) => d.kind === 'audiooutput'), 'MacBook Pro Speakers');
  populateSelect(micSel,    inputs, 'MacBook Pro Microphone');
}

function populateSelect(sel, devices, preferHint) {
  sel.innerHTML = '';
  devices.forEach((d) => {
    const opt = document.createElement('option');
    opt.value       = d.deviceId;
    opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;
    sel.appendChild(opt);
  });
  const preferred = [...sel.options].find((o) =>
    o.textContent.toLowerCase().includes(preferHint.toLowerCase()),
  );
  if (preferred) sel.value = preferred.value;
}

// ── Model loading ─────────────────────────────────────────────────────────────

async function loadModel() {
  goBtn.disabled = true;
  await engine.loadModel((msg, pct) => {
    setStatus(msg, 'loading');
    goBtn.style.setProperty('--progress', `${pct}%`);
  });
  setStatus('Ready — pick devices and hit Go', 'ready');
  goBtn.disabled = false;
  goBtn.classList.remove('loading');
  goBtn.textContent = 'Go';
}

// ── Recording lifecycle ───────────────────────────────────────────────────────

async function toggleRecording() {
  if (isRecording) await stopRecording();
  else             await startRecording();
}

async function startRecording() {
  const inputId  = inputSel.value;
  const outputId = outputSel.value;

  // Start a new session only if one isn't already in progress.
  // Resuming after Pause reuses the same timestamp and transcript.
  if (!sessionTimestamp) {
    sessionTimestamp = timestamp();
    currentTranscript = '';
    transcriptEl.textContent = '';
    notesStatus.textContent  = '';
    // Reset recording buffers for a fresh session (not on pause/resume).
    mainRecBuffer = [];
    myRecBuffer   = [];
  }
  subtitleEl.textContent = '';

  setStatus('Starting…', 'loading');

  // Reset both VADs
  mainVAD = createVAD(null);
  myVAD   = createVAD('Me');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputId ? { exact: inputId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    setStatus(`Microphone error: ${err.message}`, 'error');
    return;
  }

  // Pass-through monitoring
  if (passthroughCb.checked) {
    monitorAudio = new Audio();
    monitorAudio.srcObject = mediaStream;
    monitorAudio.muted = false;
    if (outputId && monitorAudio.setSinkId) {
      try { await monitorAudio.setSinkId(outputId); } catch { /* best-effort */ }
    }
    await monitorAudio.play();
  }

  // AudioWorklet pipeline
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(audioProcessorUrl);
  const source  = audioContext.createMediaStreamSource(mediaStream);
  workletNode   = new AudioWorkletNode(audioContext, 'audio-downsample-processor');

  workletNode.port.onmessage = (e) => {
    if (e.data.type === 'frame') {
      mainRecBuffer.push(e.data.data);
      onAudioFrame(e.data.data, mainVAD);
    }
  };

  source.connect(workletNode);

  // Worklet must be connected to the destination or Chromium's audio engine
  // will skip processing the node entirely (lazy graph optimization).
  // Route through a silent gain so no audio plays back.
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  workletNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  // Optional second mic stream — transcription only, never passed through
  if (captureMicCb.checked) {
    try {
      const micId = micSel.value;
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micId ? { exact: micId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const micSource = audioContext.createMediaStreamSource(micStream);
      micWorklet = new AudioWorkletNode(audioContext, 'audio-downsample-processor');
      micWorklet.port.onmessage = (e) => {
        if (e.data.type === 'frame') {
          myRecBuffer.push(e.data.data);
          onAudioFrame(e.data.data, myVAD);
        }
      };
      micSource.connect(micWorklet);
      const micGain = audioContext.createGain();
      micGain.gain.value = 0;
      micWorklet.connect(micGain);
      micGain.connect(audioContext.destination);
    } catch (err) {
      console.warn('[Mic capture] Could not open mic stream:', err.message);
    }
  }

  isRecording = true;
  goBtn.textContent = 'Pause';
  goBtn.classList.add('recording');
  setStatus('Listening… (hit Pause to stop, Generate Notes when done)', 'recording');
}

async function stopRecording() {
  if (!isRecording) return;
  setStatus('Finishing…', 'loading');

  workletNode?.disconnect();
  micWorklet?.disconnect();
  mediaStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  micStream  = null;
  micWorklet = null;
  if (monitorAudio) {
    monitorAudio.pause();
    monitorAudio.srcObject = null;
    monitorAudio = null;
  }
  await audioContext?.close();

  // Flush any remaining speech in either VAD
  const flushJobs = [mainVAD, myVAD]
    .filter((v) => v.buffer.length > 0 && v.speechFrames >= MIN_SPEECH_FRAMES)
    .map((v) => flushSegment(v));
  await Promise.all(flushJobs);

  isRecording = false;
  goBtn.textContent = 'Go';
  goBtn.classList.remove('recording');
  subtitleEl.textContent = '';

  if (currentTranscript.trim()) {
    notesBtn.disabled = false;
    setStatus('Paused — hit Go to resume or Generate Notes when ready', 'ready');
  } else {
    setStatus('Ready — pick devices and hit Go', 'ready');
  }
}

// ── Energy VAD ────────────────────────────────────────────────────────────────

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function onAudioFrame(frame, vad) {
  vad.smoothedRms = SMOOTH_ALPHA * rms(frame) + (1 - SMOOTH_ALPHA) * vad.smoothedRms;

  if (vad.state === 'silence') {
    if (vad.smoothedRms > SPEECH_RMS) {
      vad.state        = 'speaking';
      vad.speechFrames  = 1;
      vad.silenceFrames = 0;
      vad.buffer.push(frame);
      setSubtitleSpeaking();
    }
  } else {
    vad.buffer.push(frame);

    if (vad.smoothedRms > SPEECH_RMS) {
      vad.speechFrames++;
      vad.silenceFrames = 0;
    } else {
      vad.silenceFrames++;
      if (vad.silenceFrames >= SILENCE_HOLD_FRAMES && vad.speechFrames >= MIN_SPEECH_FRAMES) {
        flushSegment(vad);
        return;
      }
    }

    if (vad.buffer.length >= MAX_SPEECH_FRAMES) {
      flushSegment(vad);
    }
  }
}

// Typing segments queue — serialises the word-by-word animation
let _typeChain = Promise.resolve();

async function flushSegment(vad) {
  if (vad.flushing) return;
  vad.flushing = true;

  const frames      = vad.buffer;
  vad.buffer        = [];
  vad.state         = 'silence';
  vad.smoothedRms   = 0;
  vad.speechFrames  = 0;
  vad.silenceFrames = 0;

  // Concatenate frames into a single Float32Array
  const total = frames.reduce((n, f) => n + f.length, 0);
  const audio = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    audio.set(f, offset);
    offset += f.length;
  }

  subtitleEl.innerHTML = '<span class="subtitle-thinking">Transcribing…</span>';

  let text = '';
  try {
    ({ text } = await engine.transcribeSegment(audio));
  } catch (err) {
    console.error('[VAD] Transcription error:', err);
    setStatus(`Transcription error: ${err.message}`, 'error');
    subtitleEl.textContent = '';
  }

  // Release lock immediately so next segment can start transcribing
  // while this one is still being typed in
  vad.flushing = false;

  if (text) {
    _typeChain = _typeChain.then(() => typeInSegment(text, vad.label));
  } else {
    subtitleEl.textContent = '';
  }
}

// ── File drop / batch mode ────────────────────────────────────────────────────

async function handleFile(file) {
  if (isRecording) await stopRecording();

  sessionTimestamp      = timestamp();
  currentTranscript     = '';
  subtitleEl.textContent    = '';
  transcriptEl.textContent  = '';
  notesStatus.textContent   = '';
  notesBtn.disabled         = true;

  goBtn.disabled = true;
  setStatus(`Decoding ${file.name}…`, 'loading');

  let pcm;
  try {
    pcm = await decodeAudioFile(file, (pct) => {
      setStatus(`Decoding ${file.name}… ${pct}%`, 'loading');
    });
  } catch (err) {
    setStatus(`Failed to decode file: ${err.message}`, 'error');
    goBtn.disabled = false;
    return;
  }

  setStatus(`Transcribing ${file.name}…`, 'loading');

  let fileResult;
  try {
    fileResult = await engine.transcribeFile(pcm, ({ chunkText }) => {
      // Each chunk flows in word-by-word via the same typing queue as live mode
      if (chunkText.trim()) {
        _typeChain = _typeChain.then(() => typeInSegment(chunkText));
      }
    });
    // Wait for all queued typing animations to finish
    await _typeChain;
  } catch (err) {
    setStatus(`Transcription failed: ${err.message}`, 'error');
    goBtn.disabled = false;
    return;
  }

  // Fallback: if chunk callbacks fired empty (depends on model/format),
  // type in the full result returned by transcribeFile instead
  if (!currentTranscript.trim() && fileResult?.text?.trim()) {
    await typeInSegment(fileResult.text);
  }

  goBtn.disabled = false;
  notesBtn.disabled = false;
  await finishSession(currentTranscript, sessionTimestamp);
}

// ── Hybrid re-transcription ───────────────────────────────────────────────────

// ── WAV encoding helpers ──────────────────────────────────────────────────────

/**
 * Mix two equal-length (or differently-sized) Float32Array streams sample by
 * sample. If lengths differ the shorter stream is treated as zero-padded.
 * Output is clamped to [-1, 1].
 */
function mixBuffers(a, b) {
  const len = Math.max(a.length, b.length);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const s = (i < a.length ? a[i] : 0) + (i < b.length ? b[i] : 0);
    out[i] = Math.max(-1, Math.min(1, s));
  }
  return out;
}

/**
 * Encode a 16 kHz mono Float32Array to a 16-bit PCM WAV ArrayBuffer.
 * Returns the raw bytes as a Uint8Array suitable for IPC transfer.
 */
function encodeWav(float32, sampleRate = 16000) {
  const numSamples = float32.length;
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0,  'RIFF');
  view.setUint32(4,  36 + dataSize, true);
  writeStr(8,  'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);           // chunk size
  view.setUint16(20, 1,  true);           // PCM
  view.setUint16(22, 1,  true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

// ── Frame concatenation ───────────────────────────────────────────────────────

/** Concatenate an array of Float32Array frames into a single Float32Array. */
function concatFrames(frames) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) { out.set(f, offset); offset += f.length; }
  return out;
}

/**
 * Re-transcribe the recorded session audio at high quality, merge the two
 * streams chronologically (with [Me] speaker labels for the mic stream),
 * update currentTranscript, and refresh the transcript panel.
 *
 * Falls back silently if no recording buffers exist (file-drop mode).
 * @returns {Promise<boolean>} true if enhancement ran, false if skipped.
 */
async function enhanceTranscript() {
  if (mainRecBuffer.length === 0) return false;

  setStatus('Re-processing audio for higher accuracy…', 'loading');

  const mainPcm = concatFrames(mainRecBuffer);
  const hasMic  = myRecBuffer.length > 0;
  const myPcm   = hasMic ? concatFrames(myRecBuffer) : null;

  let mainChunks = [];
  let myChunks   = [];

  // Re-transcribe main stream with chunk timestamps
  try {
    const mainResult = await engine.transcribeFileTimestamped(mainPcm, (chunkText) => {
      if (chunkText.trim()) setStatus(`Re-processing… ${chunkText.slice(0, 40)}…`, 'loading');
    });
    mainChunks = (mainResult.chunks ?? []).map((c) => ({ ...c, speaker: null }));
  } catch (err) {
    console.error('[Enhance] Main stream re-transcription failed:', err);
    setStatus('Re-processing failed — using live transcript.', 'ready');
    return false;
  }

  // Re-transcribe mic stream if present
  if (hasMic) {
    try {
      const myResult = await engine.transcribeFileTimestamped(myPcm);
      myChunks = (myResult.chunks ?? []).map((c) => ({ ...c, speaker: 'Me' }));
    } catch (err) {
      console.warn('[Enhance] Mic stream re-transcription failed:', err);
      // Non-fatal: continue with just main stream
    }
  }

  // Merge both streams chronologically by chunk start time
  const allChunks = [...mainChunks, ...myChunks]
    .filter((c) => c.text?.trim())
    .sort((a, b) => (a.timestamp?.[0] ?? 0) - (b.timestamp?.[0] ?? 0));

  if (allChunks.length === 0) {
    setStatus('Re-processing yielded no text — using live transcript.', 'ready');
    return false;
  }

  // Build plain-text transcript with [Me] labels
  const lines = allChunks.map((c) =>
    c.speaker ? `[${c.speaker}] ${c.text.trim()}` : c.text.trim()
  );
  const enhancedText = lines.join(' ');

  currentTranscript = enhancedText;
  updateTranscriptPanel(enhancedText);
  setStatus('Re-processing complete — generating notes…', 'loading');
  return true;
}

// ── Shared finish pipeline ────────────────────────────────────────────────────

async function finishSession(text, ts) {
  if (!text.trim()) {
    setStatus('Nothing was transcribed.', 'ready');
    return;
  }

  const transcriptPath = `recordings/transcript-${ts}.txt`;
  const notesPath      = `recordings/meeting-notes-${ts}.md`;

  await window.api.saveTranscript({ text, filePath: transcriptPath });

  setStatus('Generating notes…', 'loading');
  notesStatus.textContent = 'Generating meeting notes…';

  const res = await window.api.generateNotes({ transcriptText: text, notesPath });

  if (res.ok) {
    setStatus('Done — notes saved!', 'ready');
    notesStatus.textContent = `✓ Notes saved to recordings/meeting-notes-${ts}.md`;
  } else {
    setStatus(`Notes failed: ${res.error}`, 'error');
    notesStatus.textContent = `⚠ Notes failed: ${res.error}`;
  }
}

// ── Notes button handler ──────────────────────────────────────────────────────

async function generateNotesHandler() {
  if (!currentTranscript.trim() || !sessionTimestamp) return;
  notesBtn.disabled = true;
  notesBtn.classList.add('running');
  notesBtn.textContent = 'Processing…';

  // Save WAV recording if we have captured audio (live session, not file-drop mode)
  if (mainRecBuffer.length > 0) {
    try {
      const mainPcm = concatFrames(mainRecBuffer);
      const hasMic  = myRecBuffer.length > 0;
      const mixed   = hasMic ? mixBuffers(mainPcm, concatFrames(myRecBuffer)) : mainPcm;
      const wavBytes = encodeWav(mixed, 16000);
      await window.api.saveAudio({
        bytes:    Array.from(wavBytes),
        filePath: `recordings/recording-${sessionTimestamp}.wav`,
      });
    } catch (err) {
      console.warn('[WAV] Failed to save recording:', err.message);
    }

    // Re-transcribe at high quality — replaces currentTranscript if successful
    await enhanceTranscript();
  }

  notesBtn.textContent = 'Generating…';
  await finishSession(currentTranscript, sessionTimestamp);
  notesBtn.classList.remove('running');
  notesBtn.textContent = 'Generate Notes';
  notesBtn.disabled = false;
}

// ── New Session (Clear) ───────────────────────────────────────────────────────

function newSession() {
  if (isRecording) return;
  sessionTimestamp      = null;
  currentTranscript     = '';
  transcriptEl.textContent  = '';
  notesStatus.textContent   = '';
  subtitleEl.textContent    = '';
  notesBtn.disabled         = true;
  mainRecBuffer = [];
  myRecBuffer   = [];
  setStatus('Ready — pick devices and hit Go', 'ready');
}

// ── Word-by-word typing animation ────────────────────────────────────────────

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Escape text for safe innerHTML use. */
function _esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Type a new segment into the transcript word-by-word.
 * Committed text stays full-brightness; the arriving words fade in dimmed,
 * then snap to full brightness on commit.
 */
async function typeInSegment(text, speakerLabel = null) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return;

  const base       = currentTranscript;
  const labelHtml  = speakerLabel
    ? `<span class="speaker-me">${_esc(speakerLabel)}:</span> `
    : '';
  const labelPlain = speakerLabel ? `[${speakerLabel}] ` : '';

  for (let i = 0; i < words.length; i++) {
    const partial = words.slice(0, i + 1).join(' ');

    subtitleEl.innerHTML = `<span class="subtitle-streaming">${labelHtml}${_esc(partial)}</span>`;

    const pending = `<span class="transcript-pending">${labelHtml}${_esc(partial)}</span>`;
    transcriptEl.innerHTML = base
      ? `${_esc(base)} ${pending}`
      : pending;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;

    await _sleep(38);
  }

  // Commit — plain text for the saved transcript file, rich HTML for the panel
  const plainSegment = labelPlain + text.trim();
  currentTranscript = base + (base ? ' ' : '') + plainSegment;
  updateSubtitles(text.trim());
  updateTranscriptPanel(currentTranscript);
  autoSaveTranscript(currentTranscript, sessionTimestamp);
  notesBtn.disabled = false;
}

// ── Auto-save ─────────────────────────────────────────────────────────────────

let _autoSaveTimer = null;
function autoSaveTranscript(text, ts) {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    window.api.saveTranscript({ text, filePath: `recordings/transcript-${ts}.txt` });
  }, 2000);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setStatus(msg, state) {
  statusEl.textContent = msg;
  statusEl.className   = `status ${state}`;
}

function setSubtitleSpeaking() {
  subtitleEl.innerHTML = '<span class="subtitle-speaking">● Speaking…</span>';
}

let _subtitleTimer = null;
function updateSubtitles(text) {
  subtitleEl.textContent = text;
  clearTimeout(_subtitleTimer);
  _subtitleTimer = setTimeout(() => { subtitleEl.textContent = ''; }, 5000);
}

function updateTranscriptPanel(text) {
  transcriptEl.textContent = text;
  transcriptEl.scrollTop   = transcriptEl.scrollHeight;
}

function onPassthroughToggle() {
  const on = passthroughCb.checked;
  if (monitorAudio) monitorAudio.muted = !on;
  outputSel.disabled = !on;
  captureMicCb.disabled = !on;
  captureMicGroup.classList.toggle('disabled', !on);
  if (!on) {
    captureMicCb.checked = false;
    onCaptureMicToggle();
  }
}

function onCaptureMicToggle() {
  const on = captureMicCb.checked;
  micSel.disabled = !on;
  captureMicGroup.classList.toggle('muted', !on);
}

function toggleEqPanel(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : !eqPanel.classList.contains('open');
  eqPanel.classList.toggle('open', open);
  eqBtn.classList.toggle('active', open);
}

function onEqChange(id, el) {
  const v = Number(el.value);
  // Update the displayed value next to the slider label
  const valEl = $(`eq-val-${id.replace('eq-', '')}`);
  if (valEl) valEl.textContent = v;

  if (id === 'eq-sensitivity') {
    // 1 (least sensitive) → SPEECH_RMS 0.040 ; 10 (most sensitive) → 0.004
    SPEECH_RMS  = 0.040 - (v - 1) * (0.036 / 9);
    SILENCE_RMS = SPEECH_RMS * 0.65;
  } else if (id === 'eq-reactivity') {
    // 1 (smooth) → SMOOTH_ALPHA 0.05 ; 10 (reactive) → 0.40
    SMOOTH_ALPHA = 0.05 + (v - 1) * (0.35 / 9);
  } else if (id === 'eq-minspeech') {
    // 1 (short, ~30 ms) → 3 frames ; 10 (long, ~800 ms) → 80 frames
    MIN_SPEECH_FRAMES = Math.round(3 + (v - 1) * (77 / 9));
  } else if (id === 'eq-silence') {
    // 1 (fast, ~100 ms) → 10 frames ; 10 (slow, ~1500 ms) → 150 frames
    SILENCE_HOLD_FRAMES = Math.round(10 + (v - 1) * (140 / 9));
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── Start ─────────────────────────────────────────────────────────────────────
init().catch((err) => {
  console.error(err);
  setStatus(`Startup error: ${err.message}`, 'error');
});
