import { useEffect, useRef, useState } from 'react';
import { X, Sliders, Mic, Moon, Sun, Eye, EyeOff, Key, Check, RefreshCw, Cpu, Download, FolderOpen, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/appStore.js';
import { recorder } from '../engine/recorder.js';

const CURSOR_MODELS = [
  { id: 'composer-2.5',                  label: 'composer-2.5 (default)' },
  { id: 'composer-2.5-fast',             label: 'composer-2.5-fast' },
  { id: 'claude-4.6-sonnet-medium',      label: 'claude-4.6-sonnet' },
  { id: 'claude-opus-4-8-thinking-high', label: 'claude-opus-4' },
];

const SliderRow = ({ label, min, max, step = 1, value, onChange, tooltip }) => {
  const [showTip, setShowTip] = useState(false);
  return (
    <div>
      <div className="flex justify-between items-center mb-1.5">
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, position: 'relative' }}>
          <span className="text-[12px] text-[#5c5448]">{label}</span>
          {tooltip && (
            <span
              style={{ position: 'relative', display: 'inline-flex', cursor: 'default' }}
              onMouseEnter={() => setShowTip(true)}
              onMouseLeave={() => setShowTip(false)}
            >
              <span style={{
                width: 13, height: 13, borderRadius: '50%', background: '#ede9df',
                color: '#9c9285', fontSize: 9, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                lineHeight: 1, userSelect: 'none',
              }}>?</span>
              {showTip && (
                <span style={{
                  position: 'absolute', bottom: '120%', left: '50%', transform: 'translateX(-50%)',
                  background: '#2a2520', color: '#f5f2e9', fontSize: 11, lineHeight: 1.4,
                  padding: '6px 9px', borderRadius: 8, whiteSpace: 'normal', width: 180,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.25)', zIndex: 100, pointerEvents: 'none',
                  textAlign: 'center',
                }}>
                  {tooltip}
                </span>
              )}
            </span>
          )}
        </div>
        <span className="text-[11px] text-[#5c6e00] font-semibold w-8 text-right tabular-nums">{value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer h-[3px] rounded-full accent-[#5c6e00]"
        style={{
          background: `linear-gradient(to right, #5c6e00 ${((value - min) / (max - min)) * 100}%, #ddd9cf ${((value - min) / (max - min)) * 100}%)`
        }}
      />
    </div>
  );
};

const SectionLabel = ({ children }) => (
  <p style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 14 }}>
    {children}
  </p>
);

const SelectField = ({ icon: Icon, label, value, onChange, options }) => (
  <div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
      <Icon size={10} /> {label}
    </div>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--ink)', fontSize: 12, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', outline: 'none' }}
    >
      {options.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 12)}</option>
      ))}
    </select>
  </div>
);

export function SettingsDrawer({ open, onClose }) {
  const {
    eqSensitivity, eqReactivity, eqMinSpeech, eqSilence, setEq,
    liveTxEnabled, setLiveTx,
    liveSummaryEnabled, setLiveSummaryOn,
    summaryIntervalSecs, setSummaryInterval,
    darkMode, setDarkMode,
    devices, setDevices,
    micDeviceId, setMicDeviceId,
    loopbackEnabled, setLoopbackEnabled,
    micEnabled, setMicEnabled,
    cursorApiKey, setCursorApiKey,
    setGenConfig,
  } = useAppStore();

  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [savedKey, setSavedKey]       = useState('');
  const [showKey, setShowKey]         = useState(false);
  const [keySaved, setKeySaved]       = useState(false);
  const [keySaveError, setKeySaveError] = useState('');

  // ── Gen model state ──────────────────────────────────────────────────────
  const [genProvider,      setGenProvider]      = useState('cursor');
  const [cursorModelDraft, setCursorModelDraft] = useState('composer-2.5');
  const [endpointDraft,    setEndpointDraft]    = useState('http://localhost:11434');
  const [ollamaModelDraft, setOllamaModelDraft] = useState('');
  const [ollamaModels,     setOllamaModels]     = useState([]);
  const [ollamaStatus,     setOllamaStatus]     = useState(''); // '' | 'loading' | 'error:<msg>'
  const savedGenRef = useRef(null);

  // ── Local model state ─────────────────────────────────────────────────────
  const [localModels,       setLocalModels]      = useState([]);   // [{name,path,sizeBytes}]
  const [localModelPath,    setLocalModelPathUI] = useState('');
  const [recommended,       setRecommended]      = useState([]);
  const [downloadingId,     setDownloadingId]    = useState(null); // modelId being downloaded
  const [downloadPct,       setDownloadPct]      = useState(0);
  const [downloadError,     setDownloadError]    = useState('');
  const [customUrl,         setCustomUrl]        = useState('');

  useEffect(() => {
    if (!open) return;
    recorder.enumerateDevices().then((devs) => {
      setDevices(devs);
    }).catch((err) => console.warn('[SettingsDrawer] enumerateDevices failed:', err.message)); // [C12]
    window.api.getApiKey().then((key) => {
      const k = key || '';
      setApiKeyDraft(k);
      setSavedKey(k);
      setCursorApiKey(k);
    }).catch((err) => console.warn('[SettingsDrawer] getApiKey failed:', err.message)); // [C12]
    window.api.getGenConfig().then((cfg) => {
      setGenProvider(cfg.provider);
      setCursorModelDraft(cfg.cursorModel);
      setEndpointDraft(cfg.ollamaEndpoint);
      setOllamaModelDraft(cfg.ollamaModel);
      setLocalModelPathUI(cfg.localModelPath || '');
      savedGenRef.current = cfg;
      if (cfg.provider === 'ollama') fetchOllamaModels(cfg.ollamaEndpoint);
      if (cfg.provider === 'local') refreshLocalModels();
    }).catch((err) => console.warn('[SettingsDrawer] getGenConfig failed:', err.message));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire download progress
  useEffect(() => {
    window.api.onModelDownloadProgress((payload) => {
      setDownloadPct(payload.pct || 0);
      if (payload.done) {
        setDownloadingId(null);
        setDownloadPct(0);
        refreshLocalModels();
      }
    });
    return () => window.api.offModelDownloadProgress();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save api key on drawer close (key has an explicit Save button too)
  useEffect(() => {
    if (open) return;
    const trimmed = apiKeyDraft.trim();
    if (trimmed !== savedKey) saveApiKey(trimmed);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchOllamaModels(ep) {
    const endpoint = ep ?? endpointDraft;
    setOllamaStatus('loading');
    setOllamaModels([]);
    try {
      const res = await window.api.listOllamaModels(endpoint);
      console.log('[SettingsDrawer] listOllamaModels result:', res);
      if (res.ok) {
        setOllamaModels(res.models);
        setOllamaStatus('');
      } else {
        setOllamaStatus(`error:${res.error}`);
      }
    } catch (err) {
      console.error('[SettingsDrawer] listOllamaModels threw:', err);
      setOllamaStatus(`error:${err.message}`);
    }
  }

  const persistGenConfig = async (cfg) => {
    try {
      await window.api.setGenConfig(cfg);
      savedGenRef.current = cfg;
      setGenConfig(cfg);
      console.log('[SettingsDrawer] gen config saved:', cfg);
    } catch (err) {
      console.error('[SettingsDrawer] setGenConfig failed:', err);
    }
  };

  const refreshLocalModels = async () => {
    try {
      const res = await window.api.listModels();
      if (res.ok) {
        setLocalModels(res.models);
        setRecommended(res.recommended || []);
      }
    } catch (err) {
      console.warn('[SettingsDrawer] listModels failed:', err.message);
    }
  };

  const handleDownload = async (modelId) => {
    setDownloadingId(modelId);
    setDownloadPct(0);
    setDownloadError('');
    const res = await window.api.downloadModel(modelId);
    if (!res.ok && !res.canceled) {
      setDownloadError(res.error || 'Download failed');
      setDownloadingId(null);
    }
  };

  const handleDownloadUrl = async () => {
    const url = customUrl.trim();
    if (!url) return;
    const filename = url.split('/').pop().split('?')[0] || 'model.gguf';
    const modelId = `custom:${filename}`;
    setDownloadingId(modelId);
    setDownloadPct(0);
    setDownloadError('');
    const res = await window.api.downloadModelUrl(url, filename);
    if (!res.ok && !res.canceled) {
      setDownloadError(res.error || 'Download failed');
      setDownloadingId(null);
    } else if (res.ok) {
      setCustomUrl('');
    }
  };

  const handleImport = async () => {
    const res = await window.api.importModel();
    if (res.ok) {
      refreshLocalModels();
      selectLocalModel(res.path);
    }
  };

  const handleDeleteModel = async (modelPath) => {
    const res = await window.api.deleteModel(modelPath);
    if (res.ok) {
      refreshLocalModels();
      if (localModelPath === modelPath) selectLocalModel('');
    }
  };

  const selectLocalModel = (path) => {
    setLocalModelPathUI(path);
    const cfg = { provider: genProvider, cursorModel: cursorModelDraft, ollamaEndpoint: endpointDraft, ollamaModel: ollamaModelDraft, localModelPath: path };
    persistGenConfig(cfg);
  };

  const fmtBytes = (b) => {
    if (!b) return '';
    if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
    return `${(b / 1e6).toFixed(0)} MB`;
  };

  // Save immediately when any gen config field changes
  const changeProvider = (v) => {
    setGenProvider(v);
    const cfg = { provider: v, cursorModel: cursorModelDraft, ollamaEndpoint: endpointDraft, ollamaModel: ollamaModelDraft, localModelPath };
    persistGenConfig(cfg);
    if (v === 'ollama') fetchOllamaModels(endpointDraft);
    if (v === 'local') refreshLocalModels();
  };
  const changeCursorModel = (v) => {
    setCursorModelDraft(v);
    persistGenConfig({ provider: genProvider, cursorModel: v, ollamaEndpoint: endpointDraft, ollamaModel: ollamaModelDraft, localModelPath });
  };
  const changeOllamaModel = (v) => {
    setOllamaModelDraft(v);
    persistGenConfig({ provider: genProvider, cursorModel: cursorModelDraft, ollamaEndpoint: endpointDraft, ollamaModel: v, localModelPath });
  };
  const changeEndpoint = (v) => {
    setEndpointDraft(v);
    // endpoint is saved on blur/Enter to avoid saving mid-type
  };
  const commitEndpoint = (v) => {
    const ep = v ?? endpointDraft;
    persistGenConfig({ provider: genProvider, cursorModel: cursorModelDraft, ollamaEndpoint: ep, ollamaModel: ollamaModelDraft, localModelPath });
    fetchOllamaModels(ep);
  };

  const saveApiKey = async (keyOverride) => {
    const trimmed = (keyOverride !== undefined ? keyOverride : apiKeyDraft).trim();
    setKeySaveError('');
    try {
      await window.api.setApiKey(trimmed);
      setSavedKey(trimmed);
      setCursorApiKey(trimmed);
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 2000);
    } catch (err) {
      setKeySaveError('Save failed — check console for details.');
      console.error('[SettingsDrawer] setApiKey failed:', err);
    }
  };

  const applyEq = (field, val) => {
    setEq(field, val);
    if (field === 'eqSensitivity') {
      recorder.SPEECH_RMS  = 0.040 - (val - 1) * (0.036 / 9);
      recorder.SILENCE_RMS = recorder.SPEECH_RMS * 0.65;
    } else if (field === 'eqReactivity') {
      recorder.SMOOTH_ALPHA = 0.05 + (val - 1) * (0.35 / 9);
    } else if (field === 'eqMinSpeech') {
      recorder.MIN_SPEECH_FRAMES = Math.round(3 + (val - 1) * (77 / 9));
    } else if (field === 'eqSilence') {
      recorder.SILENCE_HOLD_FRAMES = Math.round(10 + (val - 1) * (140 / 9));
    }
  };

  if (!open) return null;

  const col = { padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 0 };
  const divider = { borderRight: '1px solid var(--border-soft)' };
  const selectStyle = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--ink)', fontSize: 12, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', outline: 'none' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(26,24,20,0.45)' }}
      onClick={onClose}
    >
      <div
        className="animate-fade-in"
        style={{
          width: 620,
          background: 'var(--bg-surface)',
          borderRadius: 18,
          border: '1px solid var(--border)',
          boxShadow: '0 32px 80px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.15)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 22px',
          borderBottom: '1px solid var(--border-soft)',
          background: 'var(--bg-surface2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15, color: 'var(--ink)' }}>
            <Sliders size={15} color="var(--ink-faint)" />
            Settings
          </div>
          <button
            onClick={onClose}
            style={{ padding: 6, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-faint)', display: 'flex' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface3)'; e.currentTarget.style.color = 'var(--ink)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-faint)'; }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Body — three columns */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>

          {/* Audio */}
          <div style={{ ...col, ...divider }}>
            <SectionLabel>Audio</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Loopback toggle */}
              <div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                  <span style={{ fontSize: 13, color: 'var(--ink)' }}>Capture call audio</span>
                  <input
                    type="checkbox"
                    checked={loopbackEnabled}
                    onChange={(e) => setLoopbackEnabled(e.target.checked)}
                    className="accent-[#5c6e00]"
                    style={{ width: 15, height: 15 }}
                  />
                </label>
                <p style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 4, lineHeight: 1.4 }}>
                  Records what you hear — no Zoom changes needed
                </p>
              </div>

              {/* Mic toggle + device picker */}
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                <span style={{ fontSize: 13, color: 'var(--ink)' }}>Use microphone</span>
                <input
                  type="checkbox"
                  checked={micEnabled}
                  onChange={(e) => setMicEnabled(e.target.checked)}
                  className="accent-[#5c6e00]"
                  style={{ width: 15, height: 15 }}
                />
              </label>
              {micEnabled && (
                <SelectField
                  icon={Mic} label="Microphone"
                  value={micDeviceId} onChange={setMicDeviceId}
                  options={inputs}
                />
              )}

            </div>
          </div>

          {/* Processing */}
          <div style={{ ...col, ...divider }}>
            <SectionLabel>Processing</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Dark mode toggle */}
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--ink)' }}>
                  {darkMode ? <Moon size={13} color="#7c5fc2" /> : <Sun size={13} color="#c47a00" />}
                  Dark mode
                </span>
                <input
                  type="checkbox"
                  checked={darkMode}
                  onChange={(e) => setDarkMode(e.target.checked)}
                  className="accent-[#5c6e00]"
                  style={{ width: 15, height: 15 }}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                <span style={{ fontSize: 13, color: 'var(--ink)' }}>Live transcription</span>
                <input
                  type="checkbox"
                  checked={liveTxEnabled}
                  onChange={(e) => { setLiveTx(e.target.checked); recorder._liveTx = e.target.checked; }}
                  className="accent-[#5c6e00]"
                  style={{ width: 15, height: 15 }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                <span style={{ fontSize: 13, color: 'var(--ink)' }}>Live summary</span>
                <input
                  type="checkbox"
                  checked={liveSummaryEnabled}
                  onChange={(e) => setLiveSummaryOn(e.target.checked)}
                  className="accent-[#5c6e00]"
                  style={{ width: 15, height: 15 }}
                />
              </label>
              {liveSummaryEnabled && (
                <SliderRow
                  label={`Summary interval (${summaryIntervalSecs}s)`}
                  min={10} max={300} step={10}
                  value={summaryIntervalSecs}
                  onChange={setSummaryInterval}
                />
              )}
            </div>
          </div>

          {/* Voice Detection */}
          <div style={col}>
            <SectionLabel>Voice Detection</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <SliderRow label="Sensitivity" min={1} max={10} value={eqSensitivity} onChange={(v) => applyEq('eqSensitivity', v)}
                tooltip="How loud audio needs to be to count as speech. Higher = only picks up louder voices." />
              <SliderRow label="Reactivity"  min={1} max={10} value={eqReactivity}  onChange={(v) => applyEq('eqReactivity', v)}
                tooltip="How quickly the meter responds to volume changes. Higher = snappier but jitterier." />
              <SliderRow label="Min speech"  min={1} max={10} value={eqMinSpeech}   onChange={(v) => applyEq('eqMinSpeech', v)}
                tooltip="Minimum duration of sound before it's treated as speech. Higher = filters out short noises." />
              <SliderRow label="Silence gap" min={1} max={10} value={eqSilence}     onChange={(v) => applyEq('eqSilence', v)}
                tooltip="How long a pause must be before a speech chunk ends. Higher = fewer, longer transcript segments." />
            </div>
          </div>

        </div>

        {/* AI Model */}
        <div style={{ borderTop: '1px solid var(--border-soft)', padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.09em' }}>
            <Cpu size={10} /> AI Model
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>

            {/* Provider picker */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 }}>
              <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Provider</span>
              <select
                value={genProvider}
                onChange={(e) => changeProvider(e.target.value)}
                style={selectStyle}
              >
                <option value="cursor">Cursor</option>
                <option value="ollama">Ollama (local)</option>
                <option value="local">Local (built-in)</option>
              </select>
            </div>

            {genProvider === 'cursor' ? (
              /* Cursor model picker */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Model</span>
                <select
                  value={cursorModelDraft}
                  onChange={(e) => changeCursorModel(e.target.value)}
                  style={{ ...selectStyle, width: '100%' }}
                >
                  {CURSOR_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            ) : genProvider === 'ollama' ? (
              /* Ollama endpoint + model */
              <div style={{ display: 'flex', flex: 1, gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 160px' }}>
                  <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Endpoint</span>
                  <input
                    type="text"
                    value={endpointDraft}
                    onChange={(e) => changeEndpoint(e.target.value)}
                    onBlur={(e) => commitEndpoint(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { commitEndpoint(endpointDraft); } e.stopPropagation(); }}
                    spellCheck={false}
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--ink)', fontSize: 12, padding: '6px 8px', borderRadius: 8, outline: 'none', fontFamily: 'monospace' }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 140px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Model</span>
                    <button
                      onClick={() => commitEndpoint(endpointDraft)}
                      title="Refresh model list"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', padding: 2, display: 'flex' }}
                    >
                      <RefreshCw size={11} className={ollamaStatus === 'loading' ? 'animate-spin' : ''} />
                    </button>
                  </div>
                  {ollamaStatus === 'loading' ? (
                    <div style={{ fontSize: 12, color: 'var(--ink-faint)', padding: '6px 8px' }}>Detecting…</div>
                  ) : ollamaStatus.startsWith('error:') ? (
                    <div style={{ fontSize: 11, color: '#c0392b', lineHeight: 1.4 }}>
                      {ollamaStatus.slice(6) || 'Ollama not reachable'}
                    </div>
                  ) : ollamaModels.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>No models found</div>
                  ) : (
                    <select
                      value={ollamaModelDraft}
                      onChange={(e) => changeOllamaModel(e.target.value)}
                      style={{ ...selectStyle, width: '100%' }}
                    >
                      {ollamaModelDraft === '' && <option value="">— pick a model —</option>}
                      {ollamaModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ) : genProvider === 'local' ? (
              /* Built-in local model panel */
              <div style={{ display: 'flex', flex: 1, flexDirection: 'column', gap: 10 }}>

                {/* Downloaded models list */}
                {localModels.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Installed models</span>
                    {localModels.map((m) => (
                      <div key={m.path} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer' }}>
                          <input
                            type="radio"
                            name="localModel"
                            value={m.path}
                            checked={localModelPath === m.path}
                            onChange={() => selectLocalModel(m.path)}
                            style={{ accentColor: '#5c6e00' }}
                          />
                          <span style={{ fontSize: 12, color: 'var(--ink)', fontFamily: 'monospace', fontSize: 11 }}>
                            {m.name}
                          </span>
                          <span style={{ fontSize: 10, color: 'var(--ink-faint)' }}>
                            {fmtBytes(m.sizeBytes)}
                          </span>
                        </label>
                        <button
                          onClick={() => handleDeleteModel(m.path)}
                          title="Delete model"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', padding: 2, display: 'flex' }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Download recommended */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Download a model</span>
                  {recommended.map((m) => {
                    const alreadyInstalled = localModels.some((lm) => lm.name === m.filename);
                    const isDownloading = downloadingId === m.id;
                    return (
                      <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, color: 'var(--ink)', flex: 1 }}>{m.name}</span>
                          {alreadyInstalled ? (
                            <span style={{ fontSize: 11, color: '#5c6e00' }}>Installed</span>
                          ) : isDownloading ? (
                            <button
                              onClick={() => { window.api.cancelModelDownload(m.id); setDownloadingId(null); setDownloadPct(0); }}
                              style={{ fontSize: 11, color: '#c0392b', background: 'transparent', border: '1px solid #c0392b', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}
                            >
                              Cancel
                            </button>
                          ) : (
                            <button
                              onClick={() => handleDownload(m.id)}
                              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', color: 'var(--ink)' }}
                            >
                              <Download size={10} /> Download
                            </button>
                          )}
                        </div>
                        {isDownloading && (
                          <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${downloadPct}%`, background: '#5c6e00', transition: 'width 0.3s ease', borderRadius: 2 }} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {downloadError && (
                    <p style={{ fontSize: 11, color: '#c0392b', margin: 0 }}>{downloadError}</p>
                  )}
                </div>

                {/* Custom URL download */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Download from URL</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleDownloadUrl(); e.stopPropagation(); }}
                      placeholder="https://huggingface.co/…/model.gguf"
                      spellCheck={false}
                      style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--ink)', fontSize: 11, padding: '5px 8px', borderRadius: 6, outline: 'none', fontFamily: 'monospace' }}
                    />
                    <button
                      onClick={handleDownloadUrl}
                      disabled={!customUrl.trim() || !!downloadingId}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', cursor: customUrl.trim() && !downloadingId ? 'pointer' : 'not-allowed', color: 'var(--ink)', opacity: !customUrl.trim() || !!downloadingId ? 0.5 : 1 }}
                    >
                      <Download size={10} /> Download
                    </button>
                  </div>
                  {downloadingId?.startsWith('custom:') && (
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${downloadPct}%`, background: '#5c6e00', transition: 'width 0.3s ease', borderRadius: 2 }} />
                    </div>
                  )}
                </div>

                {/* Import from disk */}
                <button
                  onClick={handleImport}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: 'var(--ink)', alignSelf: 'flex-start' }}
                >
                  <FolderOpen size={11} /> Import .gguf from disk
                </button>

              </div>
            ) : null}
          </div>
        </div>

        {/* API Key */}
        <div style={{
          borderTop: '1px solid var(--border-soft)',
          padding: '16px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          ...((genProvider === 'ollama' || genProvider === 'local') && { opacity: 0.6 }),
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.09em' }}>
            <Key size={10} /> Cursor API Key{(genProvider === 'ollama' || genProvider === 'local') ? ' (not needed for this provider)' : ''}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKeyDraft}
                onChange={(e) => { setApiKeyDraft(e.target.value); setKeySaved(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') saveApiKey(); e.stopPropagation(); }}
                placeholder="cursor_..."
                spellCheck={false}
                style={{
                  width: '100%',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  color: 'var(--ink)',
                  fontSize: 12,
                  padding: '7px 36px 7px 10px',
                  borderRadius: 8,
                  outline: 'none',
                  fontFamily: 'monospace',
                  boxSizing: 'border-box',
                }}
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--ink-faint)', display: 'flex', padding: 0,
                }}
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <button
              onClick={() => saveApiKey()}
              style={{
                padding: '7px 14px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: keySaved ? '#5c6e00' : 'var(--bg-elevated)',
                color: keySaved ? '#fff' : 'var(--ink)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                transition: 'background 0.15s, color 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              {keySaved ? <><Check size={12} /> Saved</> : 'Save'}
            </button>
          </div>
          {keySaveError && (
            <p style={{ fontSize: 11, color: '#c0392b', margin: 0, lineHeight: 1.4 }}>{keySaveError}</p>
          )}
          <p style={{ fontSize: 11, color: 'var(--ink-faint)', margin: 0, lineHeight: 1.4 }}>
            Stored locally on this machine. Get your key at{' '}
            <span style={{ color: 'var(--ink)', fontFamily: 'monospace', fontSize: 10 }}>cursor.com/settings</span>.
          </p>
        </div>

      </div>
    </div>
  );
}
