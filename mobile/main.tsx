// The phone web app's entry (docs/mobile-web.md): fonts, styles, a restore left by
// Settings (finished before the app mounts, or its failure screen; "wait" while another
// window restores; any window reloads when a restore starts or ends), the shell; the
// service worker only in a build (dev never registers one).
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/600.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '../index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { RestoreFailed } from './RestoreFailed';
import { bootRestore } from './restore';
import { PENDING_KEY } from '../utils/backup';
import { t } from '../utils/i18n';

// Another window started or ended a restore: this one stops writing and starts over.
window.addEventListener('storage', e => {
  if (e.key === PENDING_KEY && (e.oldValue === null) !== (e.newValue === null)) location.reload();
});
// Back from the page cache, storage events that fired meanwhile were missed: start over.
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

const root = ReactDOM.createRoot(document.getElementById('root')!);
bootRestore().then(b => root.render(
  b.ok ? <App />
    : b.waiting ? <p role="status" className="min-h-[100dvh] flex items-center justify-center px-8 text-center text-[15px] text-mute">{t('m.restoreWaiting')}</p>
    : <RestoreFailed pending={b.pending} error={b.error} />,
));

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(console.error);
}
