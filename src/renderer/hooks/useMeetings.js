import { useCallback } from 'react';
import { useAppStore } from '../store/appStore.js';

export function useMeetings() {
  const { setMeetings, setGlobalTodos } = useAppStore();

  const refresh = useCallback(async () => {
    const [meetings, todos] = await Promise.all([
      window.api.db.listMeetings(),
      window.api.db.listTodos({ doneFilter: null }),
    ]);
    setMeetings(meetings ?? []);
    setGlobalTodos(todos ?? []);
  }, [setMeetings, setGlobalTodos]);

  const createMeeting = useCallback(async (opts = {}) => {
    const meeting = await window.api.db.createMeeting(opts);
    await refresh();
    return meeting;
  }, [refresh]);

  const deleteMeeting = useCallback(async (id) => {
    await window.api.db.deleteMeeting(id);
    await refresh();
  }, [refresh]);

  return { refresh, createMeeting, deleteMeeting };
}
