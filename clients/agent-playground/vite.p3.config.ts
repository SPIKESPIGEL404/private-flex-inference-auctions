import {defineConfig} from 'vite';
export default defineConfig({build:{outDir:'dist-p3',rollupOptions:{input:'p3.html'},target:'es2022',chunkSizeWarningLimit:1600}});
