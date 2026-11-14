import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: { alias: { 'node:zlib': new URL('./src/browser-zlib.ts', import.meta.url).pathname } },
  server: { strictPort: true, port: 4173, proxy: { '/buyer-api': { target: loadEnv(mode, '.', 'BUYER_GATEWAY_URL').BUYER_GATEWAY_URL ?? 'http://127.0.0.1:4180' } } },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
}));
