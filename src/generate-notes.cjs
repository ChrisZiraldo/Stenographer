/**
 * General-purpose streaming agent runner — used for both final meeting-notes
 * generation and rolling summaries.
 *
 * Runs in a plain Node.js child process (NOT Electron) to avoid native ABI
 * mismatches with better-sqlite3 inside Electron's bundled Node.
 *
 * Reads JSON from stdin:  { apiKey, cwd, prompt }
 *
 * Writes newline-delimited JSON events to stdout:
 *   { type: 'chunk', text: '...' }   — streamed text from the model
 *   { type: 'done' }                  — run completed successfully
 *   { type: 'error', error: '...' }   — fatal error
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
    emit({ type: 'error', error: `Invalid JSON input: ${e.message}` });
    return;
  }

  const { apiKey, cwd, prompt } = input;

  if (!apiKey || apiKey === 'cursor_...') {
    emit({ type: 'error', error: 'CURSOR_API_KEY not set' });
    return;
  }

  if (!prompt) {
    emit({ type: 'error', error: 'No prompt provided' });
    return;
  }

  let Agent, CursorAgentError;
  try {
    ({ Agent, CursorAgentError } = require('@cursor/sdk'));
  } catch (e) {
    emit({ type: 'error', error: `@cursor/sdk load failed: ${e.message}` });
    return;
  }

  let agent;
  try {
    agent = await Agent.create({
      apiKey,
      model: { id: 'composer-2.5' },
      local: { cwd: cwd || process.cwd() },
    });

    const run = await agent.send(prompt);

    for await (const event of run.stream()) {
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            emit({ type: 'chunk', text: block.text });
          }
        }
      }
    }

    const result = await run.wait();
    if (result.status === 'error') {
      emit({ type: 'error', error: `Agent run failed (id: ${result.id})` });
      return;
    }

    emit({ type: 'done' });
  } catch (err) {
    const isAgentErr = CursorAgentError && err instanceof CursorAgentError;
    emit({
      type: 'error',
      error: isAgentErr
        ? `Agent startup failed: ${err.message} (retryable: ${err.isRetryable})`
        : (err.message || String(err)),
    });
  } finally {
    if (agent) {
      try { await agent[Symbol.asyncDispose](); } catch { /* best-effort cleanup */ }
    }
  }
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
