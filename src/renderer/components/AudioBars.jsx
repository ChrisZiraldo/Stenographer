import { useAppStore } from '../store/appStore.js';

const BAR_OFFSETS = [0.7, 1.0, 0.85, 0.95, 0.65];

export function AudioBars() {
  const level  = useAppStore((s) => s.audioLevel);
  const status = useAppStore((s) => s.recordingStatus);
  const active = status === 'recording';

  return (
    <div
      className={`eq-bars transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-0'}`}
      aria-hidden="true"
    >
      {BAR_OFFSETS.map((offset, i) => {
        const barPx = active
          ? Math.max(3, Math.round(level * 18 * offset))
          : 3;
        return (
          <div
            key={i}
            className="eq-bar"
            style={{ height: barPx }}
          />
        );
      })}
    </div>
  );
}
