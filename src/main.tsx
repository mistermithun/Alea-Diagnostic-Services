import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ErrorBoundary} from './components/ErrorBoundary.tsx';
import {OfflineIndicator} from './components/PWAInstallControl.tsx';
import './index.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
    <OfflineIndicator />
  </ErrorBoundary>
);
