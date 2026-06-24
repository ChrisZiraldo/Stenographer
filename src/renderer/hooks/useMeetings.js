import { useCallback } from 'react';
import { useAppStore } from '../store/appStore.js';

export function useMeetings() {
  const { setMeetings, setGlobalTodos, setStatusMessage } = useAppStore();

  const refresh = useCallback(async () => {
    try {
      const [meetings, todos] = await Promise.all([
        window.api.db.listMeetings(),
        window.api.db.listTodos({ doneFilter: null }),
      ]);
      setMeetings(meetings ?? []);
      setGlobalTodos(todos ?? []);
    } catch (err) {
      // Surface load errors so the user sees something rather than a blank list. [C15]
      console.error('[useMeetings] refresh failed:', err);
      setStatusMessage(`Failed to load meetings: ${err.message}`);
    }
  }, [setMeetings, setGlobalTodos, setStatusMessage]);

  const createMeeting = useCallback(async (opts = {}) => {
    try {
      const meeting = await window.api.db.createMeeting(opts);
      await refresh();
      return meeting;
    } catch (err) {
      console.error('[useMeetings] createMeeting failed:', err);
      setStatusMessage(`Failed to create meeting: ${err.message}`);
      return null;
    }
  }, [refresh, setStatusMessage]);

  const deleteMeeting = useCallback(async (id) => {
    try {
      await window.api.db.deleteMeeting(id);
      await refresh();
    } catch (err) {
      console.error('[useMeetings] deleteMeeting failed:', err);
      setStatusMessage(`Failed to delete meeting: ${err.message}`);
    }
  }, [refresh, setStatusMessage]);

  return { refresh, createMeeting, deleteMeeting };
}
