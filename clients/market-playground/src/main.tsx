import { createRoot } from 'react-dom/client';

async function mount() {
  if (['/proposal', '/proposal/'].includes(location.pathname)) {
    document.documentElement.lang = 'en';
    document.title = 'Model fidelity in autonomous procurement · Private Market';
    const { default: Proposal } = await import('../../proposal/Proposal');
    createRoot(document.getElementById('root')!).render(<Proposal />);
    return;
  }
  const styles = [import('@fontsource/geist-mono/400.css'), import('@fontsource/geist-mono/500.css'), import('./style.css')];
  if (['/gpu', '/gpu/'].includes(location.pathname)) {
    document.title = 'qwen3.8-27b / GPU live';
    const [{ GpuDashboard }] = await Promise.all([import('./LiveProviderStatistics'), ...styles]);
    createRoot(document.getElementById('root')!).render(<GpuDashboard />);
  } else {
    const [{ default: App }] = await Promise.all([import('./App'), import('@wterm/react/css'), ...styles]);
    createRoot(document.getElementById('root')!).render(<App />);
  }
}
void mount();
