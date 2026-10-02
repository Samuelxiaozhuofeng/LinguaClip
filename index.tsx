/// <reference types="vite/client" />
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/500.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import RestoreFailed from './components/RestoreFailed';
import { afterStart, bootRestore } from './utils/restore';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
const render = () => root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// A restore the user started finishes here, before the app (and anything that writes) is up
// (docs/backup.md); while it isn't done, only the failure screen shows.
const boot = async () => {
  const r = await bootRestore();
  if ('pending' in r) {
    root.render(<RestoreFailed pending={r.pending} error={r.error} />);
    return;
  }
  render();
  afterStart();
};

// Plain-browser `npm run dev`: fake the Tauri shell (dev/browserMock.ts) first.
if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  import('./dev/browserMock').then(boot);
} else {
  boot();
}