/**
 * General-purpose streaming agent runner — used for both final meeting-notes
 * generation and rolling summaries.
 *
 * Runs in a plain Node.js child process (NOT Electron) to avoid native ABI
 * mismatches with better-sqlite3 inside Electron's bundled Node.
 *
 * Reads JSON from stdin:  { apiKey, cwd, prompt, provider, model, endpoint }
 *
 * Writes newline-delimited JSON events to stdout:
 *   { type: 'chunk', text: '...' }   — streamed text from the model
 *   { type: 'done' }                  — run completed successfully
 *   { type: 'error', error: '...' }   — fatal error
 *
 * Providers:
 *   'cursor'  — uses @cursor/sdk (default, requires apiKey)
 *   'ollama'  — streams from a local Ollama endpoint via fetch, no apiKey needed
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

  const { apiKey, cwd, prompt, provider = 'cursor', model, endpoint, modelPath } = input;

  if (!prompt) {
    emit({ type: 'error', error: 'No prompt provided' });
    return;
  }

  if (provider === 'ollama') {
    await runOllama({ endpoint, model, prompt });
  } else if (provider === 'local') {
    await runLocal({ modelPath, prompt });
  } else {
    await runCursor({ apiKey, cwd, model, prompt });
  }
});

// ── Cursor provider ────────────────────────────────────────────────────────────
async function runCursor({ apiKey, cwd, model, prompt }) {
  if (!apiKey || apiKey === 'cursor_...') {
    emit({ type: 'error', error: 'CURSOR_API_KEY not set' });
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
      model: { id: model || 'composer-2.5' },
      local: { cwd: cwd || process.cwd() },
    });

    const run = await agent.send(prompt);

    for await (const event of run.stream()) {
      if (event.type === 'assistant') {
        // Guard: some SDK versions may return a non-iterable content field. [G1]
        const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
        for (const block of blocks) {
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
}

// ── Ollama provider ────────────────────────────────────────────────────────────
async function runOllama({ endpoint, model, prompt }) {
  const base = (endpoint || 'http://localhost:11434').replace(/\/$/, '');

  if (!model) {
    emit({ type: 'error', error: 'No Ollama model selected. Pick one in Settings.' });
    return;
  }

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
    });
  } catch (err) {
    emit({ type: 'error', error: `Ollama unreachable at ${base}: ${err.message}` });
    return;
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    emit({ type: 'error', error: `Ollama returned HTTP ${res.status}: ${body.slice(0, 200)}` });
    return;
  }

  try {
    const decoder = new TextDecoder();
    let buf = '';

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete trailing line
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.message?.content) {
          emit({ type: 'chunk', text: msg.message.content });
        }
        if (msg.done) {
          emit({ type: 'done' });
          return;
        }
        if (msg.error) {
          emit({ type: 'error', error: `Ollama error: ${msg.error}` });
          return;
        }
      }
    }

    // Flush any remaining buffered content
    if (buf.trim()) {
      let msg;
      try { msg = JSON.parse(buf.trim()); } catch { /* ignore */ }
      if (msg?.message?.content) emit({ type: 'chunk', text: msg.message.content });
    }

    emit({ type: 'done' });
  } catch (err) {
    emit({ type: 'error', error: `Ollama stream error: ${err.message}` });
  }
}

// ── Local (node-llama-cpp) provider ───────────────────────────────────────────
async function runLocal({ modelPath, prompt }) {
  if (!modelPath) {
    emit({ type: 'error', error: 'No local model selected. Download or import one in Settings.' });
    return;
  }

  const fs = require('fs');
  if (!fs.existsSync(modelPath)) {
    emit({ type: 'error', error: `Model file not found: ${modelPath}` });
    return;
  }

  let getLlama, LlamaChatSession;
  try {
    ({ getLlama, LlamaChatSession } = await import('node-llama-cpp'));
  } catch (e) {
    emit({ type: 'error', error: `node-llama-cpp load failed: ${e.message}` });
    return;
  }

  let llama, llamaModel, context, session;
  try {
    emit({ type: 'status', message: 'Loading model into memory…' });
    // Select GPU backend by platform — 'metal' on macOS, auto elsewhere. [G2]
    const gpuBackend = process.platform === 'darwin' ? 'metal' : 'auto';
    llama = await getLlama({ gpu: gpuBackend });
    llamaModel = await llama.loadModel({ modelPath });
    emit({ type: 'status', message: 'Initialising context…' });
    // Request a generous context floor — node-llama-cpp's "auto" sizing can otherwise
    // shrink well below the model's trained context on memory-constrained machines,
    // causing long transcripts to be silently context-shifted (older tokens dropped)
    // instead of fully considered. Cap at 32768, Qwen2.5's trained context length.
    // Fall back to plain "auto" if 4096 doesn't fit in available memory. [L1]
    try {
      context = await llamaModel.createContext({ contextSize: { min: 4096, max: 32768 } });
    } catch {
      context = await llamaModel.createContext();
    }
    const ctxSize = context.contextSize;
    emit({ type: 'status', message: `Context ready (${ctxSize.toLocaleString()} tokens).` });

    // Rough estimate (~4 chars/token) so users understand why a long transcript may
    // come out thin: node-llama-cpp shifts older tokens out rather than erroring. [L1]
    const estimatedPromptTokens = Math.ceil(prompt.length / 4);
    if (estimatedPromptTokens > ctxSize * 0.8) {
      emit({
        type: 'status',
        message: `Warning: transcript is long (~${estimatedPromptTokens.toLocaleString()} tokens) relative to this model's context (${ctxSize.toLocaleString()} tokens). Output may be thinner than expected — try a model with a larger context, or a smaller transcript.`,
      });
    }

    session = new LlamaChatSession({ contextSequence: context.getSequence() });
    emit({ type: 'status', message: 'Generating…' });

    await session.prompt(prompt, {
      onTextChunk(text) {
        if (text) emit({ type: 'chunk', text });
      },
    });

    emit({ type: 'done' });
  } catch (err) {
    emit({ type: 'error', error: `Local model error: ${err.message || String(err)}` });
  } finally {
    try { context?.dispose(); } catch { /* best-effort */ }
    try { llamaModel?.dispose(); } catch { /* best-effort */ }
    try { await llama?.dispose(); } catch { /* best-effort */ }
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
