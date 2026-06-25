/**
 * Data access layer for Stenographer's SQLite database.
 * All functions run synchronously (better-sqlite3 is sync-first).
 * Runs in the main process only.
 */
import { randomUUID } from 'crypto';
import { getDb } from './database.js';

// ── Meetings ─────────────────────────────────────────────────────────────────

export function listMeetings({ limit = 1000, offset = 0, tag = null } = {}) {
  const db = getDb();
  // tag filter: if provided, check JSON tags array contains the tag value
  const tagClause = tag ? `AND (json_extract(m.tags, '$') IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?))` : '';
  const params = tag ? [tag, limit, offset] : [limit, offset];
  const query = `
    SELECT m.*,
           n.human_doc_text,
           n.enhanced_md,
           n.summary_md,
           (SELECT COUNT(*) FROM todos WHERE meeting_id = m.id AND done = 0) AS open_todos,
           (SELECT COUNT(*) FROM todos WHERE meeting_id = m.id) AS total_todos,
           (CASE WHEN m.audio_path IS NOT NULL
                   OR m.folder_path IS NOT NULL
                   OR EXISTS (SELECT 1 FROM transcript_segments WHERE meeting_id = m.id LIMIT 1)
                 THEN 1 ELSE 0 END) AS has_recording
    FROM meetings m
    LEFT JOIN notes n ON n.meeting_id = m.id
    WHERE 1=1 ${tagClause}
    ORDER BY m.starred DESC, m.created_at DESC
    LIMIT ? OFFSET ?
  `;
  return db.prepare(query).all(...params);
}

export function toggleMeetingStar(id) {
  const db = getDb();
  db.prepare('UPDATE meetings SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?').run(Date.now(), id);
  return db.prepare('SELECT starred FROM meetings WHERE id = ?').get(id)?.starred ?? 0;
}

export function getMeeting(id) {
  const db = getDb();
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!meeting) return null;
  const notes = db.prepare('SELECT * FROM notes WHERE meeting_id = ?').get(id);
  return { ...meeting, notes: notes ?? null };
}

export function createMeeting({ title = 'Untitled Meeting', status = 'idle' } = {}) {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO meetings (id, title, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, title, now, now, status);

    db.prepare(`
      INSERT INTO notes (meeting_id, human_doc_json, human_doc_text, summary_md, enhanced_md)
      VALUES (?, '{}', '', '', '')
    `).run(id);
  })();

  return getMeeting(id);
}

export function updateMeeting(id, fields) {
  const db = getDb();
  const allowed = ['title', 'status', 'started_at', 'ended_at', 'folder_path', 'audio_path', 'duration_ms', 'tags', 'starred', 'template_type'];
  // Skip keys whose value is undefined so callers can safely pass optional
  // fields (e.g. started_at: isResume ? undefined : now) without binding errors.
  const sets = Object.keys(fields)
    .filter((k) => allowed.includes(k) && fields[k] !== undefined)
    .map((k) => `${k} = ?`);
  if (!sets.length) return;

  const values = Object.keys(fields)
    .filter((k) => allowed.includes(k) && fields[k] !== undefined)
    .map((k) => fields[k]);

  db.prepare(`
    UPDATE meetings SET ${sets.join(', ')}, updated_at = ?
    WHERE id = ?
  `).run(...values, Date.now(), id);

  // Keep the FTS index in sync whenever the title changes.
  if (fields.title !== undefined) updateFts(id);
}

export function deleteMeeting(id) {
  const db = getDb();
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  // Remove from FTS
  db.prepare("DELETE FROM meetings_fts WHERE meeting_id = ?").run(id);
}

// ── Notes ─────────────────────────────────────────────────────────────────────

export function saveNoteDoc(meetingId, { humanDocJson, humanDocText }) {
  const db = getDb();
  const info = db.prepare(`
    UPDATE notes SET human_doc_json = ?, human_doc_text = ?
    WHERE meeting_id = ?
  `).run(
    typeof humanDocJson === 'string' ? humanDocJson : JSON.stringify(humanDocJson),
    humanDocText ?? '',
    meetingId,
  );
  // [M17] Warn if no row was updated (unknown meetingId)
  if (info.changes === 0) {
    console.warn('[DB] saveNoteDoc: no notes row for meetingId', meetingId);
    return;
  }
  db.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').run(Date.now(), meetingId);
  updateFts(meetingId);
}

export function saveSummary(meetingId, summaryMd) {
  const db = getDb();
  db.prepare('UPDATE notes SET summary_md = ? WHERE meeting_id = ?').run(summaryMd, meetingId);
  db.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').run(Date.now(), meetingId);
  updateFts(meetingId);
}

export function saveGeneratedNotes(meetingId, generatedMd) {
  const db = getDb();
  db.prepare('UPDATE notes SET enhanced_md = ? WHERE meeting_id = ?').run(generatedMd, meetingId);
  db.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').run(Date.now(), meetingId);
  updateFts(meetingId);
}

// ── Transcript segments ───────────────────────────────────────────────────────

export function upsertSegments(meetingId, segments) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO transcript_segments
      (id, meeting_id, start_ms, end_ms, speaker, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((segs) => {
    for (const seg of segs) {
      insert.run(
        seg.id ?? randomUUID(),
        meetingId,
        seg.startMs ?? null,
        seg.endMs ?? null,
        seg.speaker ?? null,
        seg.text ?? '', // [M16] guard NOT NULL constraint
        seg.createdAt ?? Date.now(),
      );
    }
  });
  insertMany(segments);

  db.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').run(Date.now(), meetingId);
  updateFts(meetingId);
}

export function getSegments(meetingId) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms ASC, created_at ASC'
  ).all(meetingId);
}

// Replace all segments for a meeting atomically — delete old rows then insert
// fresh ones in one transaction. Use instead of upsertSegments when the full
// set of segments is known (pause, import, generate) to prevent duplicates.
export function replaceSegments(meetingId, segments) {
  const db = getDb();
  const del = db.prepare('DELETE FROM transcript_segments WHERE meeting_id = ?');
  const insert = db.prepare(`
    INSERT INTO transcript_segments
      (id, meeting_id, start_ms, end_ms, speaker, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    del.run(meetingId);
    for (const seg of segments) {
      insert.run(
        seg.id ?? randomUUID(),
        meetingId,
        seg.startMs ?? null,
        seg.endMs ?? null,
        seg.speaker ?? null,
        seg.text ?? '', // [M16] guard NOT NULL constraint
        seg.createdAt ?? Date.now(),
      );
    }
  })();

  db.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').run(Date.now(), meetingId);
  updateFts(meetingId);
}

// ── Todos ─────────────────────────────────────────────────────────────────────

export function listTodos({ meetingId = null, doneFilter = null } = {}) {
  const db = getDb();
  let q = 'SELECT * FROM todos';
  const params = [];
  const where = [];

  if (meetingId !== undefined) {
    where.push(meetingId === null ? 'meeting_id IS NULL' : 'meeting_id = ?');
    if (meetingId !== null) params.push(meetingId);
  }
  if (doneFilter !== null) {
    where.push('done = ?');
    params.push(doneFilter ? 1 : 0);
  }

  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY position ASC, created_at ASC';
  return db.prepare(q).all(...params);
}

// Replace all human-authored todos for a meeting atomically.
// Deletes existing source='human' rows then inserts the current editor set,
// preserving source='ai' todos. Mirrors replaceSegments semantics.
export function replaceHumanTodos(meetingId, tasks) {
  const db = getDb();
  const del = db.prepare("DELETE FROM todos WHERE meeting_id = ? AND source = 'human'");
  const ins = db.prepare(`
    INSERT INTO todos (id, meeting_id, text, done, source, position, created_at, completed_at)
    VALUES (?, ?, ?, ?, 'human', ?, ?, ?)
  `);
  const now = Date.now();

  db.transaction(() => {
    del.run(meetingId);
    tasks.forEach((task, i) => {
      ins.run(
        randomUUID(),
        meetingId,
        task.text ?? '', // [M16] guard NOT NULL constraint
        task.done ? 1 : 0,
        i,
        now,
        task.done ? now : null,
      );
    });
  })();
}

export function upsertTodo(todo) {
  const db = getDb();
  const id = todo.id ?? randomUUID();
  const now = Date.now();
  const completedAt = todo.done ? now : null;
  db.prepare(`
    INSERT INTO todos (id, meeting_id, text, done, owner, due, source, position, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      text = excluded.text,
      done = excluded.done,
      owner = excluded.owner,
      due = excluded.due,
      position = excluded.position,
      completed_at = CASE WHEN excluded.done = 1 AND todos.done = 0 THEN ? ELSE todos.completed_at END
  `).run(
    id,
    todo.meetingId ?? null,
    todo.text,
    todo.done ? 1 : 0,
    todo.owner ?? null,
    todo.due ?? null,
    todo.source ?? 'human',
    todo.position ?? 0,
    now,
    completedAt,
    now,
  );
  return id;
}

export function toggleTodo(id) {
  const db = getDb();
  const todo = db.prepare('SELECT done FROM todos WHERE id = ?').get(id);
  if (!todo) return;
  const newDone = todo.done ? 0 : 1;
  db.prepare(
    'UPDATE todos SET done = ?, completed_at = ? WHERE id = ?'
  ).run(newDone, newDone ? Date.now() : null, id);
}

export function deleteTodo(id) {
  const db = getDb();
  db.prepare('DELETE FROM todos WHERE id = ?').run(id);
}

// ── Full-text search ──────────────────────────────────────────────────────────

function updateFts(meetingId) {
  const db = getDb();
  const meeting = db.prepare('SELECT title FROM meetings WHERE id = ?').get(meetingId);
  const notes = db.prepare('SELECT human_doc_text, enhanced_md, summary_md FROM notes WHERE meeting_id = ?').get(meetingId);
  const segments = db.prepare(
    'SELECT text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms ASC'
  ).all(meetingId);

  const transcriptText = segments.map((s) => s.text).join(' ');
  const notesText = [notes?.human_doc_text, notes?.enhanced_md, notes?.summary_md].filter(Boolean).join(' ');

  db.prepare("DELETE FROM meetings_fts WHERE meeting_id = ?").run(meetingId);
  db.prepare(`
    INSERT INTO meetings_fts (meeting_id, title, notes_text, transcript_text)
    VALUES (?, ?, ?, ?)
  `).run(meetingId, meeting?.title ?? '', notesText, transcriptText);
}

export function searchMeetings(query, { limit = 20 } = {}) {
  const db = getDb();
  if (!query?.trim()) return [];
  try {
    const rows = db.prepare(`
      SELECT
        f.meeting_id,
        m.title,
        m.created_at,
        snippet(meetings_fts, 2, '<mark>', '</mark>', '…', 20) AS notes_snippet,
        snippet(meetings_fts, 3, '<mark>', '</mark>', '…', 20) AS transcript_snippet,
        rank
      FROM meetings_fts f
      JOIN meetings m ON m.id = f.meeting_id
      WHERE meetings_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query.trim() + '*', limit);
    return rows;
  } catch (err) {
    // Return a structured signal for invalid FTS queries so the renderer can
    // distinguish "no results" from "query syntax error". [M20]
    console.warn('[DB] searchMeetings FTS error:', err.message);
    return { ftsError: true, error: err.message };
  }
}

// ── Migration: import old recordings/ folder ──────────────────────────────────

export function importLegacyRecordings(recordingsDir, { existsSync, readdirSync, readFileSync }) {
  const db = getDb();
  try {
    if (!existsSync(recordingsDir)) return 0;
    const folders = readdirSync(recordingsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    let imported = 0;
    for (const folderName of folders) {
      // Deduplicate on the full resolved path so renaming the recordings
      // directory doesn't import the same sessions again. [M18]
      const fullPath = `${recordingsDir}/${folderName}`;
      const alreadyExists = db.prepare(
        "SELECT id FROM meetings WHERE folder_path = ? OR folder_path = ?"
      ).get(fullPath, folderName);
      if (alreadyExists) continue;

      const id = randomUUID();
      const now = Date.now();

      // Parse timestamp from folder name like "2026-06-18T14-30-00"
      let createdAt = now;
      const m = folderName.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
      if (m) {
        createdAt = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime() || now;
      }

      const folderPath = `${recordingsDir}/${folderName}`;
      const transcriptPath = `${folderPath}/transcript.txt`;
      const notesPath = `${folderPath}/meeting-notes.md`;
      const audioPath = `${folderPath}/recording.wav`;

      let transcriptText = '';
      let enhancedMd = '';

      try { transcriptText = readFileSync(transcriptPath, 'utf8'); } catch { /* missing */ }
      try { enhancedMd = readFileSync(notesPath, 'utf8'); } catch { /* missing */ }

      // Extract title from first line of notes or folder name
      let title = folderName;
      const firstLine = enhancedMd.split('\n').find((l) => l.startsWith('# '));
      if (firstLine) title = firstLine.replace(/^#+\s*/, '').trim() || folderName;

      db.prepare(`
        INSERT INTO meetings (id, title, created_at, updated_at, status, folder_path, audio_path)
        VALUES (?, ?, ?, ?, 'done', ?, ?)
      `).run(id, title, createdAt, createdAt, folderName, existsSync(`${audioPath}`) ? audioPath : null);

      db.prepare(`
        INSERT INTO notes (meeting_id, human_doc_json, human_doc_text, summary_md, enhanced_md)
        VALUES (?, '{}', ?, '', ?)
      `).run(id, transcriptText, enhancedMd);

      if (transcriptText) {
        const seg = {
          id: randomUUID(),
          meeting_id: id,
          start_ms: null,
          end_ms: null,
          speaker: null,
          text: transcriptText,
          created_at: createdAt,
        };
        db.prepare(`
          INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, speaker, text, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(seg.id, seg.meeting_id, seg.start_ms, seg.end_ms, seg.speaker, seg.text, seg.created_at);
      }

      updateFts(id);
      imported++;
    }
    return imported;
  } catch (err) {
    console.warn('[DB] Legacy import failed:', err.message);
    return 0;
  }
}

// ── Custom Spaces ─────────────────────────────────────────────────────────────

/**
 * Returns all custom spaces ordered by sort_order.
 * Format: [{ name, icon, color, bg, sort_order }]
 */
export function getSpaces() {
  const db = getDb();
  return db.prepare('SELECT name, icon, color, bg, sort_order FROM spaces ORDER BY sort_order ASC').all();
}

/**
 * Replaces the entire spaces list in one transaction.
 * spaces: [{ name, icon, color, bg }], order is inferred from array index.
 */
export function saveSpaces(spaces) {
  if (!Array.isArray(spaces)) return; // [M19] guard against non-array input
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO spaces (name, icon, color, bg, sort_order)
    VALUES (@name, @icon, @color, @bg, @sort_order)
    ON CONFLICT(name) DO UPDATE SET
      icon       = excluded.icon,
      color      = excluded.color,
      bg         = excluded.bg,
      sort_order = excluded.sort_order
  `);
  const deleteGone = db.prepare('DELETE FROM spaces WHERE name NOT IN (SELECT value FROM json_each(?))');

  const tx = db.transaction((list) => {
    const names = JSON.stringify(list.map((s) => s.name));
    deleteGone.run(names);
    list.forEach((s, i) => upsert.run({ name: s.name, icon: s.icon, color: s.color, bg: s.bg, sort_order: i }));
  });
  tx(spaces);
}

// ── Custom Templates ───────────────────────────────────────────────────────────

/**
 * Returns all user-created templates ordered by sort_order then created_at.
 */
export function getTemplates() {
  const db = getDb();
  return db.prepare('SELECT id, name, doc_json, source, sort_order, created_at FROM templates ORDER BY sort_order ASC, created_at ASC').all();
}

/**
 * Upserts a custom template.
 * template: { id, name, doc_json }
 */
export function saveTemplate({ id, name, doc_json }) {
  const db = getDb();
  const now = Date.now();
  const count = db.prepare('SELECT COUNT(*) AS n FROM templates').get().n;
  db.prepare(`
    INSERT INTO templates (id, name, doc_json, source, sort_order, created_at)
    VALUES (?, ?, ?, 'user', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name       = excluded.name,
      doc_json   = excluded.doc_json
  `).run(id, name, doc_json, count, now);
}

/**
 * Deletes a user-created template by id.
 */
export function deleteTemplate(id) {
  const db = getDb();
  db.prepare("DELETE FROM templates WHERE id = ? AND source = 'user'").run(id);
}
