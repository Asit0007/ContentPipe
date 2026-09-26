import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      // The live-reload socket listens on this Mac only; left alone it bound to every interface (*:24678).
      hmr: process.env.DISABLE_HMR === 'true' ? false : {host: '127.0.0.1'},
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // Outside the front end: scripts/tts-bakeoff alone is ~12k files (~950 MB, a Python env and models), and
      // watching it held the dev server at 80-97% CPU while idle (measured 2026-09-26; 0% with it ignored).
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {ignored: ['**/scripts/**', '**/.runs/**', '**/renders/**', '**/exports/**', '**/dist/**', '**/e2e/**']},
    },
  };
});
