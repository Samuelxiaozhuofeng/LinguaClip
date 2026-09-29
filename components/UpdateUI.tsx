import React, { useEffect } from 'react';
import { Btn, Card } from './ui';
import { useT } from '../utils/i18n';
import { openExternal } from '../utils/desktop';
import { checkUpdate, downloadUpdate, installUpdate, loadCurrent, openUpdate, updatesOn, useUpdate } from '../utils/update';

// One-click update (docs/update.md): the top-bar pill, the dialog, and the settings line.
const SITE = 'https://linguaclipapp.com/#download';

// Next to the wordmark; only once there is something to act on.
export const UpdatePill: React.FC = () => {
  const t = useT();
  const u = useUpdate();
  const label =
    // installFailed: back to "update available"; the dialog then offers the website.
    u.phase === 'available' || u.phase === 'dlFailed' || u.phase === 'installFailed' ? t('update.pill', { v: u.version })
    : u.phase === 'downloading' ? t('update.pillDownloading', { p: u.pct ?? 0 })
    : u.phase === 'ready' || u.phase === 'installing' ? t('update.restart')
    : null;
  if (!label) return null;
  return (
    <button type="button" onClick={() => openUpdate(true)}
      className="press ml-3 h-7 px-3 rounded-full bg-accent text-white text-xs font-medium tabular-nums">
      {label}
    </button>
  );
};

export const UpdateDialog: React.FC = () => {
  const t = useT();
  const u = useUpdate();
  const close = () => openUpdate(false); // hides only: a download keeps going

  // Capture + stop: Esc only hides this dialog, nothing underneath reacts to it.
  useEffect(() => {
    if (!u.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [u.open]);

  if (!u.open || u.phase === 'idle' || u.phase === 'checking' || u.phase === 'latest' || u.phase === 'failed') return null;
  const title = t('update.title', { v: u.version });
  const busy = u.phase === 'downloading' || u.phase === 'installing';
  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4 fade-in" onClick={close}>
      <Card className="w-full max-w-md shadow-lift" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-1">
          <h3 className="text-xl font-semibold leading-tight">{title}</h3>
          <p className="mt-1 text-xs text-mute">{t('update.current', { v: u.current })}</p>
        </div>
        {/* From the manifest: plain text, never HTML. */}
        {u.notes && <p className="px-6 pt-3 max-h-60 overflow-y-auto text-sm leading-relaxed whitespace-pre-line">{u.notes}</p>}
        {u.phase === 'downloading' && (
          <div className="px-6 pt-4">
            <div className="h-1.5 rounded-full bg-line overflow-hidden">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${u.pct ?? 0}%` }} />
            </div>
          </div>
        )}
        {u.phase === 'dlFailed' && <p className="px-6 pt-4 text-sm text-accent">{t('update.dlFailed')}</p>}
        {u.phase === 'installFailed' && <p className="px-6 pt-4 text-sm text-accent">{t('update.installFailed')}</p>}
        {u.phase === 'ready' && <p className="px-6 pt-4 text-sm text-mute">{t('update.readyHint')}</p>}
        <div className="px-6 pt-5 pb-6 flex justify-end gap-3">
          <Btn onClick={close}>{t('update.later')}</Btn>
          {(u.phase === 'available' || u.phase === 'dlFailed') && (
            <Btn tone="accent" onClick={downloadUpdate}>{u.phase === 'dlFailed' ? t('update.retry') : t('update.download')}</Btn>
          )}
          {busy && <Btn tone="accent" disabled>{u.phase === 'downloading' ? t('update.pillDownloading', { p: u.pct ?? 0 }) : t('update.installing')}</Btn>}
          {u.phase === 'ready' && <Btn tone="accent" onClick={installUpdate}>{t('update.restart')}</Btn>}
          {u.phase === 'installFailed' && <Btn tone="accent" onClick={() => openExternal(SITE).catch(err => console.error(err))}>{t('update.openSite')}</Btn>}
        </div>
      </Card>
    </div>
  );
};

// Settings, above the footer: "Version 0.2.1 · Check for updates".
export const UpdateRow: React.FC = () => {
  const t = useT();
  const u = useUpdate();
  useEffect(loadCurrent, []);
  if (!updatesOn) return null;
  const found = !['idle', 'checking', 'latest', 'failed'].includes(u.phase);
  return (
    <p className="mt-2 text-center text-xs text-mute">
      {u.current && <>{t('update.version', { v: u.current })}{' · '}</>}
      {found ? (
        <button type="button" className="text-accent underline-offset-4 hover:underline" onClick={() => openUpdate(true)}>
          {t('update.pill', { v: u.version })}
        </button>
      ) : u.phase === 'checking' ? t('update.checking') : (
        <>
          {u.phase === 'latest' && <>{t('update.latest')}{' · '}</>}
          {u.phase === 'failed' && <>{t('update.failed')}{' · '}</>}
          <button type="button" className="underline-offset-4 hover:text-ink hover:underline" onClick={() => checkUpdate()}>
            {t('update.check')}
          </button>
        </>
      )}
    </p>
  );
};
