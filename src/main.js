import { app, BrowserWindow, ipcMain, session } from 'electron';

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import { buildNotesPrompt } from './notes-prompt.js';

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
    width: 900,
    height: 720,
    minWidth: 700,
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

// ── IPC: generate meeting notes via Cursor SDK ────────────────────────────────
// Runs @cursor/sdk in a plain Node.js child process to avoid the native ABI
// mismatch between Electron's bundled Node and better-sqlite3.
ipcMain.handle('generate-notes', async (_event, { transcriptText, notesPath }) => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey || apiKey === 'cursor_...') {
    return { ok: false, error: 'CURSOR_API_KEY not set in .env' };
  }

  const prompt = buildNotesPrompt(transcriptText, notesPath);
  const projectRoot = app.getAppPath();
  // The generate-notes script lives next to main.js in the source tree.
  // At runtime the compiled file is at .vite/build/ so we go up to find src/.
  const scriptPath = join(projectRoot, 'src', 'generate-notes.cjs');

  return new Promise((resolve) => {
    // Use system Node.js. Try common Homebrew path as fallback when PATH is stripped in Electron.
    const nodeBin =
      process.env.PATH?.includes('/opt/homebrew')
        ? 'node'
        : '/opt/homebrew/bin/node';

    const child = spawn(nodeBin, [scriptPath], {
      cwd: projectRoot,
      env: { ...process.env, CURSOR_API_KEY: apiKey },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.stdin.write(JSON.stringify({ transcriptText, notesPath, apiKey, cwd: projectRoot, prompt }));
    child.stdin.end();

    child.on('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch {
        resolve({ ok: false, error: stderr || `Child process exited with code ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ ok: false, error: `Failed to spawn notes process: ${err.message}` });
    });
  });
});
