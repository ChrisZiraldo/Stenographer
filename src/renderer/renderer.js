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
let isRecording       = false;
let audioContext      = null;
let mediaStream       = null;
let workletNode       = null;
let monitorAudio      = null;   // <Audio> element for pass-through playback
let passthroughStream = null;   // MediaStream feeding monitorAudio (independent of recording)
let micStream         = null;   // second stream for "capture me" mic (no pass-through)
let micWorklet        = null;
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

// ── Rolling live summary ──────────────────────────────────────────────────────
// Every N minutes, transcribe the new audio since the last tick and stream a
// short "so far" summary into the notes panel. Off by default.
let lastSummarizedFrameIdx = 0;   // index into mainRecBuffer at last summary tick
let prevSummary            = '';  // last generated summary text
let summaryTimer           = null;
let isSummarizing          = false;
let summaryTargetTime      = 0;   // epoch ms when the next summary will fire
let countdownInterval      = null;

// ── Level meter ───────────────────────────────────────────────────────────────
let currentRmsLevel = 0;
let levelRafId      = null;

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
const eqBtn             = $('eq-btn');
const eqPanel           = $('eq-panel');
const eqClose           = $('eq-close');
const settingsBtn       = $('settings-btn');
const settingsPanel     = $('settings-panel');
const settingsClose     = $('settings-close');
const notesStatus       = $('notes-status');
const fileBtn           = $('file-btn');
const fileInput         = $('file-input');
const dropOverlay       = $('drop-overlay');
const liveTxCb          = $('live-tx-toggle');
const liveSummaryCb     = $('live-summary-toggle');
const summaryIntervalEl = $('summary-interval');
const summaryIntervalRow = $('summary-interval-row');
const levelMeterEl      = $('level-meter');
const levelMeterBar     = $('level-meter-bar');
const notesContentEl    = $('notes-content');
const notesStateEl      = $('notes-state');
const summaryCountdownEl = $('summary-countdown');
const contentSplitEl    = $('content-split');
const transcriptWrapEl  = $('transcript-wrap');
const notesWrapEl       = $('notes-wrap');
const subtitleWrapEl    = $('subtitle-wrap');

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

  // Restart pass-through when the user changes input or output device
  inputSel.addEventListener('change', () => {
    if (passthroughCb.checked) startPassthrough();
  });
  outputSel.addEventListener('change', () => {
    if (passthroughCb.checked && monitorAudio?.setSinkId) {
      monitorAudio.setSinkId(outputSel.value).catch(() => {});
    }
  });

  // Live transcription toggle shows/hides the transcript panel
  liveTxCb.addEventListener('change', () => updatePanelVisibility());

  // Live summary toggle shows/hides the notes panel and enables the interval row
  liveSummaryCb.addEventListener('change', () => {
    const on = liveSummaryCb.checked;
    summaryIntervalRow.style.opacity       = on ? '1'    : '0.4';
    summaryIntervalRow.style.pointerEvents = on ? 'auto' : 'none';
    updatePanelVisibility();
    if (on && isRecording) scheduleRollingSummary();
    else clearTimeout(summaryTimer);
  });
  summaryIntervalEl.addEventListener('change', () => {
    if (isRecording && liveSummaryCb.checked) scheduleRollingSummary();
  });

  // Apply initial visibility (both off by default)
  updatePanelVisibility();

  // EQ flyout
  eqBtn.addEventListener('click', () => toggleEqPanel());
  eqClose.addEventListener('click', () => toggleEqPanel(false));

  // Settings flyout
  settingsBtn.addEventListener('click', () => toggleSettingsPanel());
  settingsClose.addEventListener('click', () => toggleSettingsPanel(false));
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

  // Close flyout panels on click-outside
  document.addEventListener('click', (e) => {
    if (eqPanel.classList.contains('open') &&
        !eqPanel.contains(e.target) && e.target !== eqBtn && !eqBtn.contains(e.target)) {
      toggleEqPanel(false);
    }
    if (settingsPanel.classList.contains('open') &&
        !settingsPanel.contains(e.target) && e.target !== settingsBtn && !settingsBtn.contains(e.target)) {
      toggleSettingsPanel(false);
    }
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
  let maxPct = 0;
  await engine.loadModel((msg, pct, totalBytes) => {
    goBtn.textContent = msg;
    // Only advance the fill bar for large files (encoder is ~300 MB).
    const BIG_FILE = 50 * 1024 * 1024;
    if (totalBytes > BIG_FILE && pct > maxPct) {
      maxPct = pct;
      goBtn.style.setProperty('--progress', `${pct}%`);
    }
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

  // AudioWorklet pipeline
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(audioProcessorUrl);
  const source  = audioContext.createMediaStreamSource(mediaStream);
  workletNode   = new AudioWorkletNode(audioContext, 'audio-downsample-processor');

  workletNode.port.onmessage = (e) => {
    if (e.data.type === 'frame') {
      mainRecBuffer.push(e.data.data);
      currentRmsLevel = rms(e.data.data);  // feed the level meter
      if (liveTxCb?.checked) onAudioFrame(e.data.data, mainVAD);
      // Enable Generate Notes after 10 s of buffered audio even without live tx
      if (mainRecBuffer.length === 1000 && !currentTranscript) notesBtn.disabled = false;
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
          if (liveTxCb?.checked) onAudioFrame(e.data.data, myVAD);
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
  startLevelMeter();
  scheduleRollingSummary();
}

async function stopRecording() {
  if (!isRecording) return;
  clearTimeout(summaryTimer);
  stopLevelMeter();
  stopCountdown();
  setStatus('Finishing…', 'loading');

  workletNode?.disconnect();
  micWorklet?.disconnect();
  mediaStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  micStream  = null;
  micWorklet = null;

  // Pass-through is managed independently — leave it running so the user
  // keeps hearing the meeting audio while transcription is paused.

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

  // Auto-save the WAV on every pause so the meeting audio is never lost.
  // mainRecBuffer accumulates across pause/resume, so each save is cumulative.
  if (mainRecBuffer.length > 0 && sessionTimestamp) {
    const mainPcm  = concatFrames(mainRecBuffer);
    const hasMic   = myRecBuffer.length > 0;
    const mixed    = hasMic ? mixBuffers(mainPcm, concatFrames(myRecBuffer)) : mainPcm;
    const wavBytes = encodeWav(mixed, 16000);
    window.api.saveAudio({
      bytes:    Array.from(wavBytes),
      filePath: `recordings/${sessionTimestamp}/recording.wav`,
    }).catch((err) => console.warn('[WAV auto-save] Failed:', err.message));
  }

  const hasContent = currentTranscript.trim() || mainRecBuffer.length >= 1000;
  if (hasContent) {
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

// ── Level meter ───────────────────────────────────────────────────────────────

function startLevelMeter() {
  levelMeterEl?.classList.add('active');
  if (levelRafId) return;
  function tick() {
    if (levelMeterBar) {
      const pct = Math.min(100, (currentRmsLevel / 0.05) * 100);
      levelMeterBar.style.width = `${pct.toFixed(1)}%`;
    }
    levelRafId = requestAnimationFrame(tick);
  }
  levelRafId = requestAnimationFrame(tick);
}

function stopLevelMeter() {
  levelMeterEl?.classList.remove('active');
  if (levelRafId) { cancelAnimationFrame(levelRafId); levelRafId = null; }
  if (levelMeterBar) levelMeterBar.style.width = '0%';
  currentRmsLevel = 0;
}

// ── Summary countdown ─────────────────────────────────────────────────────────

function startCountdown(targetMs) {
  summaryTargetTime = targetMs;
  stopCountdown();
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, summaryTargetTime - Date.now());
    if (!summaryCountdownEl) return;
    if (remaining === 0 || isSummarizing) {
      summaryCountdownEl.textContent = '';
      return;
    }
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    summaryCountdownEl.textContent = mins > 0
      ? `${mins}m ${String(secs).padStart(2, '0')}s`
      : `${secs}s`;
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = null;
  if (summaryCountdownEl) summaryCountdownEl.textContent = '';
}

// ── Rolling live summary ──────────────────────────────────────────────────────

function scheduleRollingSummary() {
  clearTimeout(summaryTimer);
  if (!liveSummaryCb?.checked || !isRecording) {
    stopCountdown();
    return;
  }
  const mins = Math.max(1, parseInt(summaryIntervalEl?.value ?? '10', 10));
  const delayMs = mins * 60_000;
  summaryTimer = setTimeout(runRollingSummary, delayMs);
  startCountdown(Date.now() + delayMs);
}

async function runRollingSummary() {
  if (!isRecording || isSummarizing || !liveSummaryCb?.checked) {
    scheduleRollingSummary();
    return;
  }

  const newFrames = mainRecBuffer.slice(lastSummarizedFrameIdx);
  const MIN_FRAMES = 100 * 10;  // need at least 10 s of new audio
  if (newFrames.length < MIN_FRAMES) {
    scheduleRollingSummary();
    return;
  }

  isSummarizing = true;
  lastSummarizedFrameIdx = mainRecBuffer.length;
  stopCountdown();
  setNotesState('Transcribing…');

  let deltaText = '';
  try {
    const deltaPcm = concatFrames(newFrames);
    const result = await engine.transcribeFileTimestamped(deltaPcm);
    deltaText = (result.chunks ?? [])
      .filter((c) => c.text?.trim())
      .map((c) => c.text.trim())
      .join(' ');
  } catch (err) {
    console.warn('[Summary] Delta transcription failed:', err.message);
    isSummarizing = false;
    setNotesState('');
    scheduleRollingSummary();
    return;
  }

  if (!deltaText.trim()) {
    isSummarizing = false;
    setNotesState('');
    scheduleRollingSummary();
    return;
  }

  setNotesState('Summarising…');
  let accumulated = '';
  notesContentEl.textContent = '';

  window.api.onSummaryChunk((text) => {
    accumulated += text;
    notesContentEl.textContent = accumulated;
    notesContentEl.scrollTop = notesContentEl.scrollHeight;
  });

  try {
    await window.api.generateSummary({ prevSummary, deltaText });
    prevSummary = accumulated;
  } catch (err) {
    console.warn('[Summary] Generation failed:', err.message);
  } finally {
    window.api.offSummaryChunk();
    isSummarizing = false;
    setNotesState('');
    scheduleRollingSummary();
  }
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

  // Preserve the live transcript so we can restore it if re-transcription fails.
  const previousTranscript = currentTranscript;

  // Clear the panel — refined text streams in chunk-by-chunk.
  currentTranscript = '';
  updateTranscriptPanel('');

  let mainChunks = [];
  let myChunks   = [];

  // Re-transcribe main stream, appending each chunk to the panel as it arrives.
  try {
    const mainResult = await engine.transcribeFileTimestamped(mainPcm, (chunkText) => {
      if (!chunkText.trim()) return;
      currentTranscript += (currentTranscript ? ' ' : '') + chunkText.trim();
      updateTranscriptPanel(currentTranscript);
      setStatus(`Re-processing… ${chunkText.trim().slice(0, 50)}…`, 'loading');
    });
    mainChunks = (mainResult.chunks ?? []).map((c) => ({ ...c, speaker: null }));

    // Fallback: some Parakeet builds return empty utterance_text in onChunk but
    // populate chunks[].text or result.text — use those if onChunk produced nothing.
    if (!currentTranscript.trim()) {
      const fallback = mainChunks
        .filter((c) => c.text?.trim())
        .map((c) => c.text.trim())
        .join(' ')
        || mainResult.text?.trim()
        || '';
      if (fallback) {
        currentTranscript = fallback;
        updateTranscriptPanel(currentTranscript);
      }
    }
  } catch (err) {
    console.error('[Enhance] Main stream re-transcription failed:', err);
    // Restore previous transcript so notes generation still has something to work with.
    currentTranscript = previousTranscript;
    updateTranscriptPanel(currentTranscript);
    setStatus('Re-processing failed — using live transcript.', 'ready');
    return false;
  }

  // Re-transcribe mic stream if present, then do a final chronological merge.
  if (hasMic) {
    setStatus('Re-processing mic stream…', 'loading');
    try {
      const myResult = await engine.transcribeFileTimestamped(myPcm);
      myChunks = (myResult.chunks ?? []).map((c) => ({ ...c, speaker: 'Me' }));
    } catch (err) {
      console.warn('[Enhance] Mic stream re-transcription failed:', err);
    }

    if (myChunks.length > 0) {
      // Merge both streams chronologically and replace the panel with the final result.
      const allChunks = [...mainChunks, ...myChunks]
        .filter((c) => c.text?.trim())
        .sort((a, b) => (a.timestamp?.[0] ?? 0) - (b.timestamp?.[0] ?? 0));

      const enhancedText = allChunks
        .map((c) => (c.speaker ? `[${c.speaker}] ${c.text.trim()}` : c.text.trim()))
        .join(' ');

      currentTranscript = enhancedText;
      updateTranscriptPanel(enhancedText);
    }
  }

  if (!currentTranscript.trim()) {
    // Everything failed — restore what we had before so Generate Notes still works.
    currentTranscript = previousTranscript;
    updateTranscriptPanel(currentTranscript);
    setStatus('Re-processing yielded no text — using prior transcript.', 'ready');
    return false;
  }

  setStatus('Re-processing complete — generating notes…', 'loading');
  return true;
}

// ── Shared finish pipeline ────────────────────────────────────────────────────
// Used by both the Generate Notes button and the file-drop handler.

async function finishSession(text, ts) {
  if (!text.trim()) {
    setStatus('Nothing was transcribed.', 'ready');
    return;
  }

  // Make both panels visible for the streaming output
  updatePanelVisibility({ showTranscript: true, showNotes: true });

  const transcriptPath = `recordings/${ts}/transcript.txt`;
  const notesPath      = `recordings/${ts}/meeting-notes.md`;

  await window.api.saveTranscript({ text, filePath: transcriptPath });

  setStatus('Generating notes…', 'loading');
  notesStatus.textContent = 'Generating meeting notes…';
  notesContentEl.textContent = '';
  setNotesState('Generating…');

  // Stream notes chunks into the panel as the model writes them
  window.api.onNotesChunk((chunk) => {
    notesContentEl.textContent += chunk;
    notesContentEl.scrollTop = notesContentEl.scrollHeight;
  });

  const res = await window.api.generateNotes({ transcriptText: text, notesPath });
  window.api.offNotesChunk();
  setNotesState('');

  if (res.ok) {
    setStatus('Done — notes saved!', 'ready');
    notesStatus.innerHTML = '';
    const msg = document.createTextNode(`✓ Saved to recordings/${ts}/`);
    const openBtn = document.createElement('button');
    openBtn.className = 'btn-link';
    openBtn.textContent = 'Open in Finder →';
    openBtn.addEventListener('click', () => window.api.openRecordingsFolder());
    notesStatus.appendChild(msg);
    notesStatus.appendChild(openBtn);
  } else {
    setStatus(`Notes failed: ${res.error}`, 'error');
    notesStatus.textContent = `⚠ Notes failed: ${res.error}`;
    if (!notesContentEl.textContent.trim()) {
      notesContentEl.textContent = `Error generating notes: ${res.error}`;
    }
  }

  // Restore panel visibility based on toggle state now that streaming is done.
  // Keep panels open if they have content (user may want to read them).
  const keepTx    = liveTxCb?.checked    || transcriptEl.textContent.trim().length > 0;
  const keepNotes = liveSummaryCb?.checked || notesContentEl.textContent.trim().length > 0;
  updatePanelVisibility({ showTranscript: keepTx, showNotes: keepNotes });
}

// ── Notes button handler (Layer 3 pipeline) ───────────────────────────────────

async function generateNotesHandler() {
  const hasAudio = mainRecBuffer.length > 0;
  if (!hasAudio && !currentTranscript.trim()) return;
  if (!sessionTimestamp) return;

  notesBtn.disabled = true;
  notesBtn.classList.add('running');
  notesBtn.textContent = 'Processing…';

  // Reveal both panels so the user can watch re-transcription + notes stream in
  updatePanelVisibility({ showTranscript: true, showNotes: true });

  // Save WAV from recorded audio (live session only — not file-drop mode)
  if (hasAudio) {
    try {
      const mainPcm  = concatFrames(mainRecBuffer);
      const hasMic   = myRecBuffer.length > 0;
      const mixed    = hasMic ? mixBuffers(mainPcm, concatFrames(myRecBuffer)) : mainPcm;
      const wavBytes = encodeWav(mixed, 16000);
      await window.api.saveAudio({
        bytes:    Array.from(wavBytes),
        filePath: `recordings/${sessionTimestamp}/recording.wav`,
      });
    } catch (err) {
      console.warn('[WAV] Failed to save recording:', err.message);
    }

    // High-quality full-session re-transcription — streams into transcript panel
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
  clearTimeout(summaryTimer);
  stopCountdown();
  isSummarizing          = false;
  summaryTargetTime      = 0;
  lastSummarizedFrameIdx = 0;
  prevSummary            = '';
  sessionTimestamp      = null;
  currentTranscript     = '';
  transcriptEl.textContent  = '';
  notesStatus.innerHTML     = '';
  subtitleEl.textContent    = '';
  notesBtn.disabled         = true;
  mainRecBuffer = [];
  myRecBuffer   = [];
  if (notesContentEl) notesContentEl.textContent = '';
  setNotesState('');
  updatePanelVisibility();
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
    window.api.saveTranscript({ text, filePath: `recordings/${ts}/transcript.txt` });
  }, 2000);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setStatus(msg, state) {
  statusEl.textContent = msg;
  statusEl.className   = `status ${state}`;
}

function setNotesState(msg) {
  if (notesStateEl) notesStateEl.textContent = msg;
}

/**
 * Show or hide the transcript and notes panels based on the current toggle
 * states.  Pass { showTranscript: true, showNotes: true } to force both
 * visible (e.g. while Generate Notes is streaming).
 */
function updatePanelVisibility({ showTranscript, showNotes } = {}) {
  const txOn    = showTranscript ?? liveTxCb?.checked    ?? false;
  const notesOn = showNotes      ?? liveSummaryCb?.checked ?? false;

  if (transcriptWrapEl) transcriptWrapEl.style.display = txOn    ? '' : 'none';
  if (notesWrapEl)      notesWrapEl.style.display       = notesOn ? '' : 'none';
  if (contentSplitEl)   contentSplitEl.style.display    = (txOn || notesOn) ? '' : 'none';
  if (subtitleWrapEl)   subtitleWrapEl.style.display    = txOn    ? '' : 'none';
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

// ── Pass-through (independent of recording) ───────────────────────────────────
// A dedicated stream so audio flows to speakers as soon as the toggle is on,
// regardless of whether transcription is running or paused.

async function startPassthrough() {
  stopPassthrough(); // tear down any existing stream first
  const inputId  = inputSel.value;
  const outputId = outputSel.value;
  try {
    passthroughStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputId ? { exact: inputId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    monitorAudio = new Audio();
    monitorAudio.srcObject = passthroughStream;
    monitorAudio.muted = false;
    if (outputId && monitorAudio.setSinkId) {
      try { await monitorAudio.setSinkId(outputId); } catch { /* best-effort */ }
    }
    await monitorAudio.play();
  } catch (err) {
    console.warn('[Passthrough] Could not start:', err.message);
    monitorAudio = null;
    passthroughStream = null;
  }
}

function stopPassthrough() {
  if (monitorAudio) {
    monitorAudio.pause();
    monitorAudio.srcObject = null;
    monitorAudio = null;
  }
  if (passthroughStream) {
    passthroughStream.getTracks().forEach((t) => t.stop());
    passthroughStream = null;
  }
}

function onPassthroughToggle() {
  const on = passthroughCb.checked;
  outputSel.disabled = !on;
  captureMicCb.disabled = !on;
  captureMicGroup.classList.toggle('disabled', !on);
  if (on) {
    startPassthrough();
  } else {
    stopPassthrough();
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
  if (open) toggleSettingsPanel(false);  // close the other panel
}

function toggleSettingsPanel(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : !settingsPanel.classList.contains('open');
  settingsPanel.classList.toggle('open', open);
  settingsBtn.classList.toggle('active', open);
  if (open) toggleEqPanel(false);  // close the other panel
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
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
init().catch((err) => {
  console.error(err);
  setStatus(`Startup error: ${err.message}`, 'error');
});
