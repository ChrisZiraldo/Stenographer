/**
 * React hook that wires the Recorder singleton to the Zustand store.
 * Attach once at app-level (App.jsx) so events are always listened to.
 */
import { useEffect } from 'react';
import { recorder } from '../engine/recorder.js';
import { useAppStore } from '../store/appStore.js';

export function useRecorder() {
  const setStatusMessage   = useAppStore((s) => s.setStatusMessage);
  const setRecordingStatus = useAppStore((s) => s.setRecordingStatus);
  const setAudioLevel      = useAppStore((s) => s.setAudioLevel);
  const setLoadingProgress = useAppStore((s) => s.setLoadingProgress);
  const appendLiveSegment  = useAppStore((s) => s.appendLiveSegment);
  const setLiveTranscript  = useAppStore((s) => s.setLiveTranscript);
  const setLiveSummary     = useAppStore((s) => s.setLiveSummary);
  const setSummaryState    = useAppStore((s) => s.setSummaryState);

  // Read EQ values from store once at mount; these are module-level reads
  // so we can apply them synchronously without re-render dependency issues.
  const eqSensitivity = useAppStore.getState().eqSensitivity;
  const eqReactivity  = useAppStore.getState().eqReactivity;
  const eqMinSpeech   = useAppStore.getState().eqMinSpeech;
  const eqSilence     = useAppStore.getState().eqSilence;

  useEffect(() => {
    // Apply EQ defaults from the store to the recorder so values take effect
    // before the user opens Settings. [C11]
    recorder.SPEECH_RMS          = 0.040 - (eqSensitivity - 1) * (0.036 / 9);
    recorder.SILENCE_RMS         = recorder.SPEECH_RMS * 0.65;
    recorder.SMOOTH_ALPHA        = 0.05 + (eqReactivity - 1) * (0.35 / 9);
    recorder.MIN_SPEECH_FRAMES   = Math.round(3 + (eqMinSpeech - 1) * (77 / 9));
    recorder.SILENCE_HOLD_FRAMES = Math.round(10 + (eqSilence - 1) * (140 / 9));

    const onStatus = (msg, state) => {
      setStatusMessage(msg);
      setRecordingStatus(state);
    };
    // Preserve 'paused' state on non-fatal errors so the resume path stays accessible. [R19]
    const onError = (msg) => {
      setStatusMessage(msg);
      const cur = useAppStore.getState().recordingStatus;
      // An active capture must not be demoted: a failed transcription still emits
      // 'error' while the audio graph keeps running, and only pause() ends it. [R19]
      if (cur !== 'paused' && !recorder.isRecording) setRecordingStatus('idle');
    };
    const onLevel        = (l)        => setAudioLevel(l);
    const onProgress     = (msg, pct) => setLoadingProgress(pct != null ? { message: msg, pct } : null);
    const onSegment      = (seg)      => appendLiveSegment(seg);
    const onTranscript   = (t)        => setLiveTranscript(t);
    const onSummaryChunk = (s)        => setLiveSummary(s);
    const onSummaryState = (s)        => setSummaryState(s);

    recorder.on('status',        onStatus);
    recorder.on('error',         onError);
    recorder.on('level',         onLevel);
    recorder.on('progress',      onProgress);
    recorder.on('segment',       onSegment);
    recorder.on('transcript',    onTranscript);
    recorder.on('summary-chunk', onSummaryChunk);
    recorder.on('summary-state', onSummaryState);

    // Load the model once on mount; surface failures to the store [C14]
    recorder.loadModel().catch((err) => {
      console.error('[useRecorder] loadModel failed:', err);
      setStatusMessage(`Model load failed: ${err.message}`);
      setRecordingStatus('error');
    });

    return () => {
      recorder.off('status',        onStatus);
      recorder.off('error',         onError);
      recorder.off('level',         onLevel);
      recorder.off('progress',      onProgress);
      recorder.off('segment',       onSegment);
      recorder.off('transcript',    onTranscript);
      recorder.off('summary-chunk', onSummaryChunk);
      recorder.off('summary-state', onSummaryState);
    };
  }, []); // Empty deps — callbacks are stable because they reference store actions directly
}
