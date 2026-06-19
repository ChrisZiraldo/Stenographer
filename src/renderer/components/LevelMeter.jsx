import { useAppStore } from '../store/appStore.js';

export function LevelMeter() {
  const level = useAppStore((s) => s.audioLevel);
  const status = useAppStore((s) => s.recordingStatus);
  const active = status === 'recording';

  return (
    <div className={`h-[3px] w-20 rounded-full bg-[#ede9df] overflow-hidden transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-0'}`}>
      <div
        className="h-full rounded-full bg-[#5c6e00] transition-all duration-75"
        style={{ width: `${(level * 100).toFixed(1)}%` }}
      />
    </div>
  );
}
