import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session, shell } from 'electron';

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';
import { existsSync, readdirSync, readFileSync, watch as fsWatch } from 'fs';
import { tmpdir } from 'os';
import dotenv from 'dotenv';
import { buildNotesPrompt, buildSummaryPrompt, buildMergePrompt, buildAutoTitlePrompt } from './notes-prompt.js';
import { initDb, closeDb } from './db/database.js';
import * as repo from './db/repositories.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// User data directory — writable in both dev and packaged DMG.
// Resolves to ~/Library/Application Support/Stenographer/
const dataDir = resolve(app.getPath('userData'));

// Resolve a renderer-supplied path to an absolute path inside userData.
// Throws if the resolved path escapes the sandbox (path traversal protection).
function resolveDataPath(p) {
  if (!p || typeof p !== 'string') throw new Error('Invalid path argument');
  const abs = resolve(isAbsolute(p) ? p : join(dataDir, p));
  if (!abs.startsWith(dataDir + sep) && abs !== dataDir) {
    throw new Error(`Path traversal rejected: "${p}"`);
  }
  return abs;
}

// Validate that a folder_path from the DB is inside a known recordings directory
// before allowing recursive deletion. Returns the absolute path or null if unsafe.
function safeRecordingsPath(folderField) {
  if (!folderField) return null;
  let abs;
  if (isAbsolute(folderField)) {
    abs = resolve(folderField);
  } else if (folderField.startsWith('recordings/') || folderField.startsWith('recordings\\')) {
    const inUserData = resolve(join(dataDir, folderField));
    const inLegacy   = resolve(join(app.getAppPath(), folderField));
    abs = existsSync(inUserData) ? inUserData : inLegacy;
  } else {
    const inUserData = resolve(join(dataDir, 'recordings', folderField));
    const inLegacy   = resolve(join(app.getAppPath(), 'recordings', folderField));
    abs = existsSync(inUserData) ? inUserData : inLegacy;
  }
  const allowedRoots = [
    resolve(join(dataDir, 'recordings')),
    resolve(join(app.getAppPath(), 'recordings')),
  ];
  const safe = allowedRoots.some((root) => abs.startsWith(root + sep) || abs === root);
  if (!safe) {
    console.warn('[security] Rejected folder_path outside recordings:', abs);
    return null;
  }
  return abs;
}

// Load .env from project root (two levels up from compiled .vite/build/main.js)
const envPath = join(app.getAppPath(), '.env');
dotenv.config({ path: envPath });

// ── Persistent settings (settings.json in userData) ───────────────────────────
const settingsPath = join(dataDir, 'settings.json');

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[settings] Failed to parse settings.json (corrupt file? resetting):', err.message);
    }
    return {};
  }
}

async function writeSettings(settings) {
  try {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] Failed to write settings.json:', settingsPath, err.message);
    throw err;
  }
}

function getStoredApiKey() {
  const stored = readSettings().cursorApiKey;
  if (stored && stored.trim()) return stored.trim();
  // Fall back to .env
  const envKey = process.env.CURSOR_API_KEY;
  if (envKey && envKey !== 'cursor_...') return envKey;
  return null;
}

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
      sandbox: true, // [M12] renderer runs in sandboxed process
    },
  });

  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    // Kill any in-flight AI generation so processes don't outlive the window.
    for (const child of _activeChildren) { try { child.kill(); } catch { /* already gone */ } }
    _activeChildren.clear();
    mainWindow = null;
  });

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
let _devNavWatcher = null;

function startDevNavWatcher() {
  if (!DEV_SERVER_URL) return; // production guard
  const navFile = join(tmpdir(), 'steno-dev-nav.json');
  try {
    _devNavWatcher = fsWatch(tmpdir(), { persistent: false }, (_eventType, filename) => {
      if (filename !== 'steno-dev-nav.json') return;
      try {
        const raw = readFileSync(navFile, 'utf8');
        const payload = JSON.parse(raw);
        mainWindow?.webContents.send('dev:navigate', payload);
      } catch { /* malformed or mid-write — ignore */ }
    });
  } catch { /* tmpdir not watchable — ignore */ }
}

// ── Single instance lock ───────────────────────────────────────────────────────
// Prevents two app instances from opening the same SQLite WAL database simultaneously,
// which can cause SQLITE_BUSY errors or corruption.
// Gate ALL IPC handlers and app.whenReady() inside gotLock so the second instance
// never briefly opens the same DB before app.quit() takes effect. [M1]
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // A second launch attempted; focus the existing window instead.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Init DB before creating window
  initDb();

  // One-time legacy migration — pick up recordings saved in the old app-bundle location
  // (dev/pre-packaging) and the current userData location.
  const legacyRecordingsDir = join(app.getAppPath(), 'recordings');
  const userRecordingsDir   = join(dataDir, 'recordings');
  repo.importLegacyRecordings(legacyRecordingsDir, { existsSync, readdirSync, readFileSync });
  repo.importLegacyRecordings(userRecordingsDir,   { existsSync, readdirSync, readFileSync });

  if (app.dock) {
    app.dock.setIcon(join(app.getAppPath(), 'assets', 'icon-dock.png'));
  }
  // Only grant audio permissions to our own app origin. [M13]
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const origin = new URL(webContents.getURL()).origin;
      const isOurOrigin = origin === 'file://' || origin === 'http://localhost:3000';
      const allowed = isOurOrigin &&
        ['media', 'microphone', 'audioCapture', 'display-capture'].includes(permission);
      callback(allowed);
    },
  );

  // Allow loopback audio capture via getDisplayMedia({ audio: 'loopback' }).
  // On macOS 14.2+ Chromium routes this through the CoreAudio Tap API.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) {
        console.warn('[desktopCapturer] getSources returned no screens');
        callback({});
        return;
      }
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  }, { useSystemPicker: false });

  createWindow();
  buildMenu();
  startDevNavWatcher();
}).catch(console.error); // [M15]

app.on('window-all-closed', () => {
  // On darwin, closing the window keeps the app running in the dock;
  // don't close the DB here or it won't be available when the window is reopened.
  if (process.platform !== 'darwin') {
    closeDb();
    app.quit();
  }
});

app.on('before-quit', () => {
  _devNavWatcher?.close();
  for (const child of _activeChildren) { try { child.kill(); } catch { /* already gone */ } }
  _activeChildren.clear();
  closeDb();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    initDb(); // safe to call multiple times — idempotent
    createWindow();
  }
});

// ── IPC: open recordings folder in Finder ────────────────────────────────────
ipcMain.handle('open-recordings-folder', async () => {
  const folder = join(dataDir, 'recordings');
  if (!existsSync(folder)) await mkdir(folder, { recursive: true });
  const err = await shell.openPath(folder);
  if (err) return { ok: false, error: err };
  return { ok: true };
});

// ── IPC: save transcript ──────────────────────────────────────────────────────
ipcMain.handle('save-transcript', async (_event, { text, filePath }) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'filePath is required' };
  if (!text && text !== '') return { ok: false, error: 'text is required' };
  try {
    const abs = resolveDataPath(filePath);
    const dir = dirname(abs);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(abs, text, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: save audio recording ─────────────────────────────────────────────────
ipcMain.handle('save-audio', async (_event, { bytes, filePath }) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'filePath is required' };
  if (!bytes || !bytes.length) return { ok: false, error: 'bytes is required and must be non-empty' };
  try {
    const abs = resolveDataPath(filePath);
    const dir = dirname(abs);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(abs, Buffer.from(bytes));
    return { ok: true, path: abs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Track all live AI child processes so they can be killed on app exit.
const _activeChildren = new Set();
// Per-job-type tracking so we can kill a prior child before spawning a new one.
const _jobChildren = new Map();

function killPriorJobChild(jobType) {
  const prior = _jobChildren.get(jobType);
  if (prior) {
    try { prior.kill(); } catch { /* already gone */ }
    _activeChildren.delete(prior);
    _jobChildren.delete(jobType);
  }
}

// ── Shared streaming agent helper ─────────────────────────────────────────────
function spawnStreamingAgent({ prompt, apiKey, projectRoot, jobType, onChunk, onDone, onError }) {
  // Kill any in-flight job of the same type before spawning a replacement.
  if (jobType) killPriorJobChild(jobType);

  // In a packaged app, app.asar contents can't be exec'd directly by the OS.
  // asarUnpack copies generate-notes.cjs to app.asar.unpacked/ which IS on disk.
  // We use Electron itself as the Node runtime (ELECTRON_RUN_AS_NODE=1) so there
  // is no dependency on a system-installed Node binary.
  const asarUnpackedRoot = projectRoot.replace('app.asar', 'app.asar.unpacked');
  const scriptPath = join(asarUnpackedRoot, 'src', 'generate-notes.cjs');

  // Pass API key via stdin only, not via env — avoids it appearing in process listings. [M8]
  // Use dataDir as cwd so the agent cannot traverse to the app source tree. [M7/M21]
  const child = spawn(process.execPath, [scriptPath], {
    cwd: dataDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  _activeChildren.add(child);
  if (jobType) _jobChildren.set(jobType, child);

  let lineBuf = '';
  let finished = false;

  const done = () => { if (!finished) { finished = true; clearTimeout(agentTimeout); onDone(); } };
  const fail = (err) => { if (!finished) { finished = true; clearTimeout(agentTimeout); onError(err); } };

  // Kill hung agents after 10 minutes so the IPC promise never blocks forever. [M10]
  const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
  const agentTimeout = setTimeout(() => {
    try { child.kill(); } catch { /* already gone */ }
    fail('Agent timed out after 10 minutes');
  }, AGENT_TIMEOUT_MS);

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

  // Drain stderr to prevent the 64KB pipe buffer from filling and deadlocking.
  child.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text) console.debug('[agent stderr]', text);
  });

  // Swallow EPIPE if the child exits before consuming stdin.
  child.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') console.warn('[agent stdin]', err.message);
  });
  child.stdin.write(JSON.stringify({ apiKey, cwd: projectRoot, prompt }));
  child.stdin.end();

  child.on('error', (err) => {
    _activeChildren.delete(child);
    if (jobType) _jobChildren.delete(jobType);
    fail(`Failed to spawn agent: ${err.message}`);
  });
  child.on('close', (code) => {
    _activeChildren.delete(child);
    if (jobType) _jobChildren.delete(jobType);
    // Flush any remaining buffered output before checking finished [M9]
    if (lineBuf.trim()) {
      try {
        const msg = JSON.parse(lineBuf.trim());
        if (msg.type === 'chunk' && msg.text) onChunk(msg.text);
        else if (msg.type === 'done') { done(); return; }
        else if (msg.type === 'error') { fail(msg.error); return; }
      } catch { /* malformed partial line — ignore */ }
    }
    if (!finished) fail(`Agent process exited with code ${code}`);
  });
}

// ── IPC: API key settings ─────────────────────────────────────────────────────
ipcMain.handle('settings:getApiKey', () => {
  // Return the full key so the Settings UI can populate the draft input,
  // but mask it in logs. The renderer only displays it masked unless editing. [M14]
  return readSettings().cursorApiKey ?? '';
});

ipcMain.handle('settings:setApiKey', async (_event, key) => {
  const settings = readSettings();
  settings.cursorApiKey = key;
  await writeSettings(settings);
  return { ok: true };
});

// ── IPC: generate meeting notes (streaming) ───────────────────────────────────
ipcMain.handle('generate-notes', async (_event, { transcriptText, notesPath, meetingId }) => {
  const apiKey = getStoredApiKey();
  if (!apiKey) {
    return { ok: false, error: 'Cursor API key not set. Add it in Settings.' };
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
            const absNotes = resolveDataPath(notesPath);
            const dir = dirname(absNotes);
            if (!existsSync(dir)) await mkdir(dir, { recursive: true });
            await writeFile(absNotes, fullText, 'utf8');
          }
          if (meetingId) {
            repo.saveGeneratedNotes(meetingId, fullText);
          }
        } catch (err) {
          console.warn('[notes] Failed to save:', err.message);
          resolve({ ok: false, error: `Save failed: ${err.message}` });
          return;
        }
      }
      resolve(result);
    };

    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      jobType: 'notes',
      onChunk: (text) => {
        fullText += text;
        mainWindow?.webContents.send('notes-chunk', text);
      },
      onDone: () => settle(fullText.trim() ? { ok: true, notesPath } : { ok: false, error: 'No output produced' }),
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: generate merge (human notes + transcript) ────────────────────────────
ipcMain.handle('generate-merge', async (_event, { humanNotesText, transcriptText, meetingId }) => {
  const apiKey = getStoredApiKey();
  if (!apiKey) {
    return { ok: false, error: 'Cursor API key not set. Add it in Settings.' };
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
        try {
          repo.saveGeneratedNotes(meetingId, fullText);
        } catch (err) {
          console.warn('[main] saveGeneratedNotes failed:', err.message);
          resolve({ ok: false, error: `Save failed: ${err.message}` });
          return;
        }
      }
      resolve(result);
    };

    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      jobType: 'merge',
      onChunk: (text) => {
        fullText += text;
        mainWindow?.webContents.send('merge-chunk', text);
      },
      onDone: () => settle(fullText.trim() ? { ok: true } : { ok: false, error: 'No output produced' }),
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: generate auto-title ──────────────────────────────────────────────────
ipcMain.handle('generate-title', async (_event, { transcriptText, notesText, meetingId }) => {
  const apiKey = getStoredApiKey();
  if (!apiKey) return { ok: false, error: 'No API key' };

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
        try {
          repo.updateMeeting(meetingId, { title });
          result.title = title;
        } catch (err) {
          // Report the save failure so the caller knows the title wasn't persisted. [M2]
          console.warn('[main] auto-title updateMeeting failed:', err.message);
          resolve({ ok: false, error: `Title save failed: ${err.message}` });
          return;
        }
      }
      resolve(result);
    };
    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      jobType: 'title',
      onChunk: (text) => { fullText += text; },
      onDone: () => settle(fullText.trim() ? { ok: true } : { ok: false, error: 'No output produced' }),
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: generate rolling summary (streaming) ─────────────────────────────────
ipcMain.handle('generate-summary', async (_event, { prevSummary, deltaText, meetingId }) => {
  const apiKey = getStoredApiKey();
  if (!apiKey) {
    return { ok: false, error: 'Cursor API key not set. Add it in Settings.' };
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
      jobType: 'summary',
      onChunk: (text) => {
        fullText += text;
        mainWindow?.webContents.send('summary-chunk', text);
      },
      onDone: () => {
        if (!fullText.trim()) { settle({ ok: false, error: 'No output produced' }); return; }
        if (meetingId) {
          try {
            repo.saveSummary(meetingId, fullText);
          } catch (err) {
            // Report the save failure so the caller knows the summary wasn't persisted. [M3]
            console.warn('[main] saveSummary failed:', err.message);
            settle({ ok: false, error: `Summary save failed: ${err.message}` });
            return;
          }
        }
        settle({ ok: true });
      },
      onError: (error) => settle({ ok: false, error }),
    });
  });
});

// ── IPC: AI slash command ─────────────────────────────────────────────────────
ipcMain.handle('ai-command', async (_event, { prompt }) => {
  const apiKey = getStoredApiKey();
  if (!apiKey) return { ok: false, error: 'No API key' };
  const projectRoot = app.getAppPath();

  return new Promise((resolve) => {
    let settled = false;
    let fullText = '';
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      jobType: 'ai-command',
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
// All handlers are wrapped in try/catch and return { ok:false, error } on failure
// so the renderer gets a structured error rather than a raw IPC rejection. [M5]

function dbHandle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const result = await fn(...args);
      return result === undefined ? { ok: true } : result;
    } catch (err) {
      console.error(`[IPC] ${channel} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  });
}

dbHandle('db:listMeetings', (opts) => repo.listMeetings(opts));
dbHandle('db:getMeeting',   (id)   => repo.getMeeting(id));
dbHandle('db:createMeeting',(opts) => repo.createMeeting(opts));
dbHandle('db:updateMeeting',({ id, fields }) => {
  if (!id || !fields || typeof fields !== 'object') throw new Error('id and fields required');
  // Run audio_path through resolveDataPath regardless of whether it looks absolute,
  // using path.isAbsolute() for correct cross-platform behavior. [M6, M11]
  if (fields.audio_path) {
    try { fields.audio_path = resolveDataPath(fields.audio_path); } catch { /* leave as-is */ }
  }
  repo.updateMeeting(id, fields);
  return { ok: true };
});
dbHandle('db:deleteMeeting', async (id) => {
  // Fetch paths BEFORE deleting the DB row so we know what to clean up on disk.
  const meeting = repo.getMeeting(id);

  // Delete the filesystem folder FIRST (best-effort) so that a failed rm
  // doesn't silently orphan files. Use safeRecordingsPath to reject any
  // folder_path that doesn't resolve under a known recordings directory.
  if (meeting?.folder_path) {
    const folderAbs = safeRecordingsPath(meeting.folder_path);
    if (folderAbs) {
      try { await rm(folderAbs, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  }

  repo.deleteMeeting(id);
  return { ok: true };
});
dbHandle('db:saveNoteDoc',  ({ meetingId, humanDocJson, humanDocText }) => {
  repo.saveNoteDoc(meetingId, { humanDocJson, humanDocText });
  return { ok: true };
});
dbHandle('db:saveSummary',  ({ meetingId, summaryMd }) => { repo.saveSummary(meetingId, summaryMd); return { ok: true }; });
dbHandle('db:saveGenerated', ({ meetingId, generatedMd }) => { repo.saveGeneratedNotes(meetingId, generatedMd); return { ok: true }; });
dbHandle('db:upsertSegments',  ({ meetingId, segments }) => { repo.upsertSegments(meetingId, segments);  return { ok: true }; });
dbHandle('db:replaceSegments', ({ meetingId, segments }) => { repo.replaceSegments(meetingId, segments); return { ok: true }; });
dbHandle('db:getSegments',  (meetingId) => repo.getSegments(meetingId));
dbHandle('db:getSpaces',    () => repo.getSpaces());
dbHandle('db:saveSpaces',   (spaces) => { repo.saveSpaces(spaces); return { ok: true }; });
dbHandle('db:toggleStar',   (id) => ({ starred: repo.toggleMeetingStar(id) }));
dbHandle('db:listTodos',       (opts)                => repo.listTodos(opts));
dbHandle('db:upsertTodo',      (todo)                => ({ id: repo.upsertTodo(todo) }));
dbHandle('db:replaceHumanTodos', ({ meetingId, tasks }) => { repo.replaceHumanTodos(meetingId, tasks); return { ok: true }; });
dbHandle('db:toggleTodo',   (id)   => { repo.toggleTodo(id); return { ok: true }; });
dbHandle('db:deleteTodo',   (id)   => { repo.deleteTodo(id); return { ok: true }; });
dbHandle('db:search',       ({ query, limit }) => repo.searchMeetings(query, { limit }));
