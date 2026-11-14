import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { 'node:zlib': new URL('./src/browser-zlib.ts', import.meta.url).pathname } },
  server: { strictPort: true, port: 4173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});
