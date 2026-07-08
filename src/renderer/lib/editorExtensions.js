/**
 * Shared TipTap extension set used by both NotesEditor, FinalNotesEditor,
 * and the markdown→doc converter so every node type is registered consistently.
 */
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
// @tiptap/extension-table exports all four as named exports (no default for Table)
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';

/**
 * Returns the extension array for a TipTap editor instance or generateJSON call.
 * @param {{ placeholder?: string }} options
 */
export function buildEditorExtensions({ placeholder = '' } = {}) {
  return [
    StarterKit,
    Underline,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({ placeholder }),
  ];
}
