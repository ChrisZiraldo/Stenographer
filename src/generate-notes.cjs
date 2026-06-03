/**
 * Standalone notes generator — runs in a plain Node.js child process,
 * NOT inside Electron. This avoids the native ABI mismatch between
 * Electron's bundled Node and native addons like better-sqlite3.
 *
 * Called by main.js via child_process.spawn with JSON on stdin:
 *   { transcriptText, notesPath, apiKey, cwd }
 *
 * Writes the result JSON to stdout:
 *   { ok: true, notesPath }  or  { ok: false, error: "..." }
 */

'use strict';

// Node 18 doesn't expose Web Crypto as a global; polyfill for @cursor/sdk
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

process.stdin.setEncoding('utf8');
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    out({ ok: false, error: `Invalid JSON input: ${e.message}` });
    return;
  }

  const { transcriptText, notesPath, apiKey, cwd, prompt } = input;

  if (!apiKey || apiKey === 'cursor_...') {
    out({ ok: false, error: 'CURSOR_API_KEY not set' });
    return;
  }

  let Agent, CursorAgentError;
  try {
    ({ Agent, CursorAgentError } = require('@cursor/sdk'));
  } catch (e) {
    out({ ok: false, error: `@cursor/sdk load failed: ${e.message}` });
    return;
  }

  try {
    const result = await Agent.prompt(prompt, {
      apiKey,
      model: { id: 'composer-2.5' },
      local: { cwd: cwd || process.cwd() },
    });

    if (result.status === 'error') {
      out({ ok: false, error: `Agent run failed (id: ${result.id})` });
      return;
    }

    out({ ok: true, notesPath });
  } catch (err) {
    if (CursorAgentError && err instanceof CursorAgentError) {
      out({ ok: false, error: `Agent startup failed: ${err.message} (retryable: ${err.isRetryable})` });
    } else {
      out({ ok: false, error: err.message });
    }
  }
});

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
