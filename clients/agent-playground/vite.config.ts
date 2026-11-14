import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],resolve:{dedupe:['react','react-dom']},build:{rollupOptions:{input:{main:'index.html',p3:'p3.html'}},target:'es2022',chunkSizeWarningLimit:1600}});
