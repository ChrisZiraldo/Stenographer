/**
 * Audio file import — decodes any browser-supported audio file to 16 kHz mono
 * Float32Array using the Web Audio API (no ffmpeg required).
 *
 * Supported formats: .wav, .mp3, .m4a/.aac, .flac, .ogg, .webm (whatever
 * Chromium's codec layer handles, which is extensive on macOS).
 */

const TARGET_RATE = 16000;

/**
 * Decode an audio File/Blob and resample it to 16 kHz mono Float32Array.
 * @param {File} file
 * @param {(pct: number) => void} [onProgress]
 * @returns {Promise<Float32Array>}
 */
export async function decodeAudioFile(file, onProgress) {
  onProgress?.(0);

  const arrayBuffer = await file.arrayBuffer();
  onProgress?.(20);

  // Decode to whatever the native format is
  const tmpCtx = new AudioContext();
  let decoded;
  try {
    decoded = await tmpCtx.decodeAudioData(arrayBuffer);
  } finally {
    await tmpCtx.close();
  }
  onProgress?.(50);

  // Resample and downmix to mono @ 16 kHz using OfflineAudioContext
  const targetLength = Math.ceil(decoded.duration * TARGET_RATE);
  const offCtx = new OfflineAudioContext(1, targetLength, TARGET_RATE);

  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  src.start(0);

  const rendered = await offCtx.startRendering();
  onProgress?.(90);

  const pcm = rendered.getChannelData(0); // Float32Array
  onProgress?.(100);

  return pcm;
}

/**
 * Wire drag-and-drop events on an element.
 * Calls onFile(File) when a valid audio file is dropped.
 * @param {HTMLElement} el
 * @param {(file: File) => void} onFile
 */
export function setupDropZone(el, onFile) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('drag-over');
  });

  el.addEventListener('dragleave', () => {
    el.classList.remove('drag-over');
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file && isAudioFile(file)) {
      onFile(file);
    }
  });
}

function isAudioFile(file) {
  return (
    file.type.startsWith('audio/') ||
    /\.(wav|mp3|m4a|aac|flac|ogg|webm|mp4)$/i.test(file.name)
  );
}
