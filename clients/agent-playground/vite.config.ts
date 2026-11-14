import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],resolve:{dedupe:['react','react-dom']},build:{target:'es2022',chunkSizeWarningLimit:1600}});
