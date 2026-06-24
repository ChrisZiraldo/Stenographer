import { app, BrowserWindow, ipcMain, Menu, session, shell } from 'electron';

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, mkdir, rm } from 'fs/promises';
import { existsSync, readdirSync, readFileSync, watch as fsWatch } from 'fs';
import { tmpdir } from 'os';
import dotenv from 'dotenv';
import { buildNotesPrompt, buildSummaryPrompt, buildMergePrompt, buildAutoTitlePrompt } from './notes-prompt.js';
import { initDb, closeDb } from './db/database.js';
import * as repo from './db/repositories.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (two levels up from compiled .vite/build/main.js)
const envPath = join(app.getAppPath(), '.env');
dotenv.config({ path: envPath });

// These globals are injected at build time by the electron-forge Vite plugin.
// eslint-disable-next-line no-undef
const DEV_SERVER_URL = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : null;
// eslint-disable-next-line no-undef
const VITE_NAME = typeof MAIN_WINDOW_VITE_NAME !== 'undefined' ? MAIN_WINDOW_VITE_NAME : 'main_window';

let mainWindow = null;

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'Import Audio…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('trigger-file-import'),
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Stenographer',
    backgroundColor: '#faf8f2',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    icon: join(app.getAppPath(), 'assets', 'icon-dock.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      join(__dirname, `../renderer/${VITE_NAME}/index.html`),
    );
  }
}

// ── Dev-only mouse-free navigation ────────────────────────────────────────────
// Write {"view":"workspace","meetingId":"<id>"} (or {"view":"library"})
// to $TMPDIR/steno-dev-nav.json to switch screens without touching the mouse.
function startDevNavWatcher() {
  if (!DEV_SERVER_URL) return; // production guard
  const navFile = join(tmpdir(), 'steno-dev-nav.json');
  // Watch the temp dir for changes to the control file
  try {
    fsWatch(tmpdir(), { persistent: false }, (_eventType, filename) => {
      if (filename !== 'steno-dev-nav.json') return;
      try {
        const raw = readFileSync(navFile, 'utf8');
        const payload = JSON.parse(raw);
        mainWindow?.webContents.send('dev:navigate', payload);
      } catch { /* malformed or mid-write — ignore */ }
    });
  } catch { /* tmpdir not watchable — ignore */ }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Init DB before creating window
  initDb();

  // One-time legacy migration from recordings/ flat files
  const recordingsDir = join(app.getAppPath(), 'recordings');
  repo.importLegacyRecordings(recordingsDir, { existsSync, readdirSync, readFileSync });

  if (app.dock) {
    app.dock.setIcon(join(app.getAppPath(), 'assets', 'icon-dock.png'));
  }
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ['media', 'microphone', 'audioCapture'].includes(permission);
      callback(allowed);
    },
  );
  createWindow();
  buildMenu();
  startDevNavWatcher();
});

app.on('window-all-closed', () => {
  closeDb();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => closeDb());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: open recordings folder in Finder ────────────────────────────────────
ipcMain.handle('open-recordings-folder', async () => {
  const folder = join(app.getAppPath(), 'recordings');
  if (!existsSync(folder)) await mkdir(folder, { recursive: true });
  await shell.openPath(folder);
});

// ── IPC: save transcript ──────────────────────────────────────────────────────
ipcMain.handle('save-transcript', async (_event, { text, filePath }) => {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(filePath, text, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: save audio recording ─────────────────────────────────────────────────
ipcMain.handle('save-audio', async (_event, { bytes, filePath }) => {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(filePath, Buffer.from(bytes));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Shared streaming agent helper ─────────────────────────────────────────────
function spawnStreamingAgent({ prompt, apiKey, projectRoot, onChunk, onDone, onError }) {
  const scriptPath = join(projectRoot, 'src', 'generate-notes.cjs');
  const nodeBin = process.env.PATH?.includes('/opt/homebrew') ? 'node' : '/opt/homebrew/bin/node';

  const child = spawn(nodeBin, [scriptPath], {
    cwd: projectRoot,
    env: { ...process.env, CURSOR_API_KEY: apiKey },
  });

  let lineBuf = '';
  let finished = false;

  const done = () => { if (!finished) { finished = true; onDone(); } };
  const fail = (err) => { if (!finished) { finished = true; onError(err); } };

  child.stdout.on('data', (d) => {
    lineBuf += d.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'chunk' && msg.text) onChunk(msg.text);
        else if (msg.type === 'done') done();
        else if (msg.type === 'error') fail(msg.error);
      } catch { /* skip malformed lines */ }
    }
  });

  child.stdin.write(JSON.stringify({ apiKey, cwd: projectRoot, prompt }));
  child.stdin.end();

  child.on('error', (err) => fail(`Failed to spawn agent: ${err.message}`));
  child.on('close', (code) => { if (!finished) fail(`Agent process exited with code ${code}`); });
}

// ── IPC: generate meeting notes (streaming) ───────────────────────────────────
ipcMain.handle('generate-notes', async (_event, { transcriptText, notesPath, meetingId }) => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey || apiKey === 'cursor_...') {
    return { ok: false, error: 'CURSOR_API_KEY not set in .env' };
  }

  const prompt = buildNotesPrompt(transcriptText);
  const projectRoot = app.getAppPath();

  return new Promise((resolve) => {
    let settled = false;
    let fullText = '';

    const settle = async (result) => {
      if (settled) return;
      settled = true;
      if (result.ok && fullText.trim()) {
        try {
          if (notesPath) {
            const dir = dirname(notesPath);
            if (!existsSync(dir)) await mkdir(dir, { recursive: true });
            await writeFile(notesPath, fullText, 'utf8');
          }
          if (meetingId) {
            repo.saveGeneratedNotes(meetingId, fullText);
          }
        } catch (err) {
          console.warn('[notes] Failed to save:', err.message);
        }
      }
      resolve(result);
    };

    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      onChunk: (text) => {
        fullText += text;
        mainWindow?.webContents.send('notes-chunk', text);
      },
      onDone: () => settle({ ok: true, notesPath }),
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: generate merge (human notes + transcript) ────────────────────────────
ipcMain.handle('generate-merge', async (_event, { humanNotesText, transcriptText, meetingId }) => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey || apiKey === 'cursor_...') {
    return { ok: false, error: 'CURSOR_API_KEY not set in .env' };
  }

  const prompt = buildMergePrompt(humanNotesText, transcriptText);
  const projectRoot = app.getAppPath();

  return new Promise((resolve) => {
    let settled = false;
    let fullText = '';

    const settle = async (result) => {
      if (settled) return;
      settled = true;
      if (result.ok && fullText.trim() && meetingId) {
        try { repo.saveGeneratedNotes(meetingId, fullText); } catch { /* best-effort */ }
      }
      resolve(result);
    };

    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      onChunk: (text) => {
        fullText += text;
        mainWindow?.webContents.send('merge-chunk', text);
      },
      onDone: () => settle({ ok: true }),
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: generate auto-title ──────────────────────────────────────────────────
ipcMain.handle('generate-title', async (_event, { transcriptText, notesText, meetingId }) => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey || apiKey === 'cursor_...') return { ok: false, error: 'No API key' };

  const prompt = buildAutoTitlePrompt(transcriptText, notesText);
  const projectRoot = app.getAppPath();

  return new Promise((resolve) => {
    let settled = false;
    let fullText = '';
    const settle = async (result) => {
      if (settled) return;
      settled = true;
      if (result.ok && fullText.trim() && meetingId) {
        const title = fullText.trim().replace(/^["']|["']$/g, '').slice(0, 120);
        try { repo.updateMeeting(meetingId, { title }); } catch { /* best-effort */ }
        result.title = title;
      }
      resolve(result);
    };
    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      onChunk: (text) => { fullText += text; },
      onDone: () => settle({ ok: true }),
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: generate rolling summary (streaming) ─────────────────────────────────
ipcMain.handle('generate-summary', async (_event, { prevSummary, deltaText, meetingId }) => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey || apiKey === 'cursor_...') {
    return { ok: false, error: 'CURSOR_API_KEY not set in .env' };
  }

  const prompt = buildSummaryPrompt(prevSummary, deltaText);
  const projectRoot = app.getAppPath();

  return new Promise((resolve) => {
    let settled = false;
    let fullText = '';
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      onChunk: (text) => {
        fullText += text;
        mainWindow?.webContents.send('summary-chunk', text);
      },
      onDone: () => {
        if (meetingId && fullText.trim()) {
          try { repo.saveSummary(meetingId, fullText); } catch { /* best-effort */ }
        }
        settle({ ok: true });
      },
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: AI slash command ─────────────────────────────────────────────────────
ipcMain.handle('ai-command', async (_event, { prompt }) => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey || apiKey === 'cursor_...') return { ok: false, error: 'No API key' };
  const projectRoot = app.getAppPath();

  return new Promise((resolve) => {
    let settled = false;
    let fullText = '';
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      onChunk: (text) => {
        fullText += text;
        mainWindow?.webContents.send('ai-command-chunk', text);
      },
      onDone: () => settle({ ok: true, text: fullText }),
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: DB operations ────────────────────────────────────────────────────────

ipcMain.handle('db:listMeetings', (_e, opts) => repo.listMeetings(opts));
ipcMain.handle('db:getMeeting',   (_e, id)   => repo.getMeeting(id));
ipcMain.handle('db:createMeeting',(_e, opts) => repo.createMeeting(opts));
ipcMain.handle('db:updateMeeting',(_e, { id, fields }) => {
  // Resolve audio_path to absolute if it's a relative path
  if (fields.audio_path && !fields.audio_path.startsWith('/')) {
    fields.audio_path = join(app.getAppPath(), fields.audio_path);
  }
  repo.updateMeeting(id, fields);
  return { ok: true };
});
ipcMain.handle('db:deleteMeeting', async (_e, id) => {
  // Fetch paths before deleting the DB row
  const meeting = repo.getMeeting(id);
  repo.deleteMeeting(id);
  // Delete the recordings folder from disk so the legacy migration doesn't re-import it
  if (meeting?.folder_path) {
    const folderAbs = meeting.folder_path.startsWith('/')
      ? meeting.folder_path
      : join(app.getAppPath(), meeting.folder_path);
    try { await rm(folderAbs, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  return { ok: true };
});
ipcMain.handle('db:saveNoteDoc',  (_e, { meetingId, humanDocJson, humanDocText }) => {
  repo.saveNoteDoc(meetingId, { humanDocJson, humanDocText });
  return { ok: true };
});
ipcMain.handle('db:saveSummary',  (_e, { meetingId, summaryMd }) => { repo.saveSummary(meetingId, summaryMd); return { ok: true }; });
ipcMain.handle('db:saveGenerated', (_e, { meetingId, generatedMd }) => { repo.saveGeneratedNotes(meetingId, generatedMd); return { ok: true }; });
ipcMain.handle('db:upsertSegments',(_e, { meetingId, segments }) => { repo.upsertSegments(meetingId, segments); return { ok: true }; });
ipcMain.handle('db:getSegments',  (_e, meetingId) => repo.getSegments(meetingId));
ipcMain.handle('db:getSpaces',      () => repo.getSpaces());
ipcMain.handle('db:saveSpaces',     (_e, spaces) => { repo.saveSpaces(spaces); return { ok: true }; });
ipcMain.handle('db:toggleStar',     (_e, id) => ({ starred: repo.toggleMeetingStar(id) }));
ipcMain.handle('db:listTodos',    (_e, opts) => repo.listTodos(opts));
ipcMain.handle('db:upsertTodo',   (_e, todo) => ({ id: repo.upsertTodo(todo) }));
ipcMain.handle('db:toggleTodo',   (_e, id)   => { repo.toggleTodo(id); return { ok: true }; });
ipcMain.handle('db:deleteTodo',   (_e, id)   => { repo.deleteTodo(id); return { ok: true }; });
ipcMain.handle('db:search',       (_e, { query, limit }) => repo.searchMeetings(query, { limit }));
