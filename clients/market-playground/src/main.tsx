import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';
import { GpuDashboard } from './LiveProviderStatistics';
import '@wterm/react/css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './style.css';

const Playground = lazy(() => import('./App'));
const gpuPage = location.pathname === '/gpu';
if (gpuPage) document.title = 'qwen3.8-27b / GPU live';
createRoot(document.getElementById('root')!).render(gpuPage
  ? <GpuDashboard /> : <Suspense fallback={<div className="engine-notice">Loading playground…</div>}><Playground /></Suspense>);
