/**
 * AudioWorklet processor — runs in the audio thread.
 *
 * Downsamples input to 16 kHz mono and posts small 10 ms frames to the main
 * thread. The VAD and buffering logic live in the main thread (renderer.js)
 * so we can call Parakeet directly on complete speech segments.
 */

const TARGET_RATE = 16000;
const FRAME_MS    = 10;                           // 10 ms frames for responsive VAD
const FRAME_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000;  // 160 samples per frame

class AudioDownsampleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._inRate     = sampleRate; // eslint-disable-line no-undef
    this._ratio      = this._inRate / TARGET_RATE;
    this._buf        = new Float32Array(FRAME_SAMPLES);
    this._filled     = 0;
    this._fractional = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    // Downmix to mono
    const channels  = input.length;
    const frameCount = input[0].length;
    const mono = new Float32Array(frameCount);
    for (let ch = 0; ch < channels; ch++) {
      for (let i = 0; i < frameCount; i++) mono[i] += input[ch][i];
    }
    if (channels > 1) {
      for (let i = 0; i < frameCount; i++) mono[i] /= channels;
    }

    // Resample via linear interpolation
    let pos = this._fractional;
    while (pos < frameCount) {
      const i0  = Math.floor(pos);
      const i1  = Math.min(i0 + 1, frameCount - 1);
      const frac = pos - i0;
      this._buf[this._filled++] = mono[i0] * (1 - frac) + mono[i1] * frac;

      if (this._filled >= FRAME_SAMPLES) {
        this.port.postMessage({ type: 'frame', data: this._buf.slice() });
        this._buf   = new Float32Array(FRAME_SAMPLES);
        this._filled = 0;
      }
      pos += this._ratio;
    }
    this._fractional = pos - frameCount;
    return true;
  }
}

registerProcessor('audio-downsample-processor', AudioDownsampleProcessor);
