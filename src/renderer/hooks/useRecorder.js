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

  useEffect(() => {
    const onStatus = (msg, state) => {
      setStatusMessage(msg);
      setRecordingStatus(state);
    };
    const onLevel        = (l)        => setAudioLevel(l);
    const onProgress     = (msg, pct) => setLoadingProgress(pct != null ? { message: msg, pct } : null);
    const onSegment      = (seg)      => appendLiveSegment(seg);
    const onTranscript   = (t)        => setLiveTranscript(t);
    const onSummaryChunk = (s)        => setLiveSummary(s);
    const onSummaryState = (s)        => setSummaryState(s);

    recorder.on('status',        onStatus);
    recorder.on('level',         onLevel);
    recorder.on('progress',      onProgress);
    recorder.on('segment',       onSegment);
    recorder.on('transcript',    onTranscript);
    recorder.on('summary-chunk', onSummaryChunk);
    recorder.on('summary-state', onSummaryState);

    // Load the model once on mount
    recorder.loadModel().catch(console.error);

    return () => {
      recorder.off('status',        onStatus);
      recorder.off('level',         onLevel);
      recorder.off('progress',      onProgress);
      recorder.off('segment',       onSegment);
      recorder.off('transcript',    onTranscript);
      recorder.off('summary-chunk', onSummaryChunk);
      recorder.off('summary-state', onSummaryState);
    };
  }, []); // Empty deps — callbacks are stable because they reference store actions directly
}
