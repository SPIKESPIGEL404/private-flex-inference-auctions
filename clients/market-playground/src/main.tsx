import { createRoot } from 'react-dom/client';
import App from './App';
import '@wterm/react/css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);
