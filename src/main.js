import { app, BrowserWindow, ipcMain, session, shell } from 'electron';

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import { buildNotesPrompt, buildSummaryPrompt } from './notes-prompt.js';

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 550,
    title: 'Stenographer',
    backgroundColor: '#0f0f1a',
    titleBarStyle: 'hiddenInset',
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

// ── Permissions ───────────────────────────────────────────────────────────────
// Grant microphone access to the renderer without a system prompt in dev.
app.whenReady().then(() => {
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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
// Spawns generate-notes.cjs with a prompt, streams JSON-line events back.
// Both notes generation and rolling summaries use this same helper.
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
// Streams agent text chunks to the renderer via 'notes-chunk' events.
// Accumulates the full output and saves it to notesPath when done.
ipcMain.handle('generate-notes', async (_event, { transcriptText, notesPath }) => {
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
      // Save the accumulated markdown to disk
      if (result.ok && fullText.trim()) {
        try {
          const dir = dirname(notesPath);
          if (!existsSync(dir)) await mkdir(dir, { recursive: true });
          await writeFile(notesPath, fullText, 'utf8');
        } catch (err) {
          console.warn('[notes] Failed to save file:', err.message);
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

// ── IPC: generate rolling summary (streaming) ─────────────────────────────────
// Streams agent text chunks to the renderer via 'summary-chunk' events.
// Uses only prevSummary + deltaText to keep token cost bounded.
ipcMain.handle('generate-summary', async (_event, { prevSummary, deltaText }) => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey || apiKey === 'cursor_...') {
    return { ok: false, error: 'CURSOR_API_KEY not set in .env' };
  }

  const prompt = buildSummaryPrompt(prevSummary, deltaText);
  const projectRoot = app.getAppPath();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    spawnStreamingAgent({
      prompt,
      apiKey,
      projectRoot,
      onChunk: (text) => mainWindow?.webContents.send('summary-chunk', text),
      onDone: () => settle({ ok: true }),
      onError: (error) => settle({ ok: false, error }),
    });
  });
});
