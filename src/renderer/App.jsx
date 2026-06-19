import { useEffect } from 'react';
import { useRecorder } from './hooks/useRecorder.js';
import { useAppStore } from './store/appStore.js';
import { Library } from './views/Library.jsx';
import { Workspace } from './views/Workspace.jsx';

export default function App() {
  useRecorder();

  const view             = useAppStore((s) => s.view);
  const setView          = useAppStore((s) => s.setView);
  const setActiveMeeting = useAppStore((s) => s.setActiveMeeting);
  const darkMode         = useAppStore((s) => s.darkMode);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Dev-only: listen for mouse-free navigation signals written to a temp file
  useEffect(() => {
    if (!window.api?.onDevNavigate) return;
    window.api.onDevNavigate((payload) => {
      if (!payload?.view) return;
      if (payload.view === 'workspace' && payload.meetingId) {
        setActiveMeeting(payload.meetingId);
      } else {
        setView(payload.view);
      }
    });
    return () => window.api.offDevNavigate?.();
  }, [setView, setActiveMeeting]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {view === 'library'   && <Library />}
      {view === 'workspace' && <Workspace />}
    </div>
  );
}
