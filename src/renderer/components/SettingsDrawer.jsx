import { useEffect, useState } from 'react';
import { X, Sliders, Mic, Moon, Sun, Eye, EyeOff, Key, Check } from 'lucide-react';
import { useAppStore } from '../store/appStore.js';
import { recorder } from '../engine/recorder.js';

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
  } = useAppStore();

  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [savedKey, setSavedKey]       = useState(''); // last value actually persisted to disk
  const [showKey, setShowKey]         = useState(false);
  const [keySaved, setKeySaved]       = useState(false);
  const [keySaveError, setKeySaveError] = useState('');

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
  }, [open]);

  // Auto-save if the user closes the drawer without clicking Save
  useEffect(() => {
    if (open) return; // only runs on close
    const trimmed = apiKeyDraft.trim();
    if (trimmed === savedKey) return; // nothing changed
    saveApiKey(trimmed);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

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

        {/* API Key */}
        <div style={{
          borderTop: '1px solid var(--border-soft)',
          padding: '16px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.09em' }}>
            <Key size={10} /> Cursor API Key
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
                border: 'none',
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
                border: '1px solid var(--border)',
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
