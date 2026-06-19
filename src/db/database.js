/**
 * SQLite database setup and schema migrations for Stenographer.
 * Runs in the main process only. Never import this in the renderer.
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { mkdirSync } from 'fs';

let db = null;

export function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

export function initDb() {
  const userDataPath = app.getPath('userData');
  mkdirSync(userDataPath, { recursive: true });
  const dbPath = join(userDataPath, 'stenographer.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  `);

  const row = db.prepare('SELECT version FROM schema_version').get();
  const currentVersion = row?.version ?? 0;

  if (currentVersion < 1) {
    db.exec(`
      -- ── Meetings ───────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS meetings (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT 'Untitled Meeting',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        started_at  INTEGER,
        ended_at    INTEGER,
        status      TEXT NOT NULL DEFAULT 'idle',
        folder_path TEXT,
        audio_path  TEXT,
        duration_ms INTEGER,
        tags        TEXT DEFAULT '[]'
      );

      -- ── Notes ──────────────────────────────────────────────────────────────
      -- human_doc_json: TipTap JSON document
      -- human_doc_text: plain-text mirror for search/AI input
      -- summary_md:     rolling live summary markdown
      -- enhanced_md:    AI-merged final notes markdown
      CREATE TABLE IF NOT EXISTS notes (
        meeting_id       TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        human_doc_json   TEXT DEFAULT '{}',
        human_doc_text   TEXT DEFAULT '',
        summary_md       TEXT DEFAULT '',
        enhanced_md      TEXT DEFAULT ''
      );

      -- ── Transcript segments ────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id          TEXT PRIMARY KEY,
        meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        start_ms    INTEGER,
        end_ms      INTEGER,
        speaker     TEXT,
        text        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_meeting ON transcript_segments(meeting_id, start_ms);

      -- ── Todos ──────────────────────────────────────────────────────────────
      -- meeting_id is nullable for global todos not attached to a meeting
      -- source: 'human' = user created, 'ai' = extracted by AI
      CREATE TABLE IF NOT EXISTS todos (
        id           TEXT PRIMARY KEY,
        meeting_id   TEXT REFERENCES meetings(id) ON DELETE CASCADE,
        text         TEXT NOT NULL,
        done         INTEGER NOT NULL DEFAULT 0,
        owner        TEXT,
        due          TEXT,
        source       TEXT NOT NULL DEFAULT 'human',
        position     REAL NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_todos_meeting ON todos(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_todos_global  ON todos(done, created_at);

      -- ── Full-text search ───────────────────────────────────────────────────
      CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
        meeting_id UNINDEXED,
        title,
        notes_text,
        transcript_text,
        content='',
        tokenize='unicode61'
      );

      INSERT OR REPLACE INTO schema_version(version) VALUES (1);
    `);
  }

  if (currentVersion < 2) {
    db.exec(`
      -- ── Custom Spaces ──────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS spaces (
        name       TEXT PRIMARY KEY,
        icon       TEXT NOT NULL DEFAULT 'Star',
        color      TEXT NOT NULL DEFAULT '#5c6e00',
        bg         TEXT NOT NULL DEFAULT '#eef1d6',
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR REPLACE INTO schema_version(version) VALUES (2);
    `);
  }
}

export function closeDb() {
  db?.close();
  db = null;
}
