import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [
    tailwindcss(),
    react(),
  ],
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: {
    // The Parakeet model cache lives in IndexedDB, which is scoped to the origin.
    // A drifting dev-server port silently orphans the cache and forces a full
    // re-download from Hugging Face, so the port must be stable.
    port: 5176,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
