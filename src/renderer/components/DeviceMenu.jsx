import { Mic, ChevronDown } from 'lucide-react';
import { useAppStore } from '../store/appStore.js';

export function DeviceMenu({ onOpenSettings }) {
  const { devices, inputDeviceId } = useAppStore();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const inputLabel = inputs.find((d) => d.deviceId === inputDeviceId)?.label || 'Audio source';
  const shortLabel = inputLabel.length > 18 ? inputLabel.slice(0, 18) + '…' : inputLabel;

  return (
    <button
      onClick={onOpenSettings}
      className="no-drag flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-white border border-[#ddd9cf] text-[#5c5448] hover:text-[#1a1814] hover:bg-[#f5f2e9] text-xs transition-all cursor-pointer shadow-[0_1px_2px_rgba(26,24,20,0.06)]"
      title="Audio settings"
    >
      <Mic size={11} />
      <span className="max-w-[90px] truncate">{shortLabel}</span>
      <ChevronDown size={9} className="opacity-50" />
    </button>
  );
}
