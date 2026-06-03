import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // electron and any package with native .node binaries must stay external
      // so they resolve from node_modules at runtime rather than being bundled.
      external: [
        'electron',
        '@cursor/sdk',
        'better-sqlite3',
        'node-sqlite3',
        /\.node$/,
      ],
    },
  },
});
