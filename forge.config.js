const { VitePlugin } = require('@electron-forge/plugin-vite');
const { AutoUnpackNativesPlugin } = require('@electron-forge/plugin-auto-unpack-natives');

module.exports = {
  packagerConfig: {
    asar: true,
    // Unpack the AI child script and its SDK so the Electron binary can run them
    // as a Node process (ELECTRON_RUN_AS_NODE). Scripts inside app.asar cannot be
    // exec'd by the OS; unpacked files land in app.asar.unpacked/ which is on disk.
    asarUnpack: [
      'src/generate-notes.cjs',
      'node_modules/@cursor/**',
    ],
    name: 'Stenographer',
    icon: 'assets/icon',
    extendInfo: {
      NSAudioCaptureUsageDescription: 'Stenographer captures meeting call audio to transcribe it locally on your device.',
    },
  },
  rebuildConfig: {
    extraModules: ['better-sqlite3'],
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main.js', config: 'vite.main.config.mjs', target: 'main' },
        { entry: 'src/preload.js', config: 'vite.preload.config.mjs', target: 'preload' },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mjs',
        },
      ],
    }),
  ],
};
