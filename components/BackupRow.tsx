import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Btn, Card } from './ui';
import { dialog } from './Dialog';
import { t as tr, useLang, useT } from '../utils/i18n';
import { pickBackupDest, pickBackupFile } from '../utils/desktop';
import { IS_WINDOWS } from '../utils/platform';
import { countsOk, kindOf, lastAuto, type Listed } from '../utils/backup';
import { getAutoState, listBackups, noteLastAuto, saveBackup, subscribeAuto } from '../utils/backupData';
import { cancelBackup, describe, openBackup, startRestore } from '../utils/restore';

// "today 09:12", else the date and time.
const when = (ms: number, lang: string) => {
  const d = new Date(ms);
  const loc = lang === 'zh' ? 'zh-CN' : 'en-US';
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? tr('backup.today', { time }) : `${d.toLocaleDateString(loc)} ${time}`;
};

// Settings' bottom row (docs/backup.md): last automatic backup, "Back up…", "Restore…".
const BackupRow: React.FC = () => {
  const t = useT();
  const lang = useLang();
  const auto = useSyncExternalStore(subscribeAuto, getAutoState);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<Listed[] | null>(null); // the restore window, open when set

  useEffect(() => { listBackups().then(l => noteLastAuto(lastAuto(l))).catch(console.error); }, []);
  useEffect(() => {
    if (!list) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setList(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [list]);

  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const backup = () => work(async () => {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dest = await pickBackupDest(t('backup.fileName', { date }));
    if (!dest) return;
    try {
      const done = await saveBackup('manual', dest);
      if (done) await dialog.alert(t('backup.doneTitle'), t('backup.doneBody', { videos: done.manifest.videos, cards: done.manifest.cards }));
    } catch (e) {
      console.error(e);
      await dialog.alert(t('backup.failedTitle'), String(e).includes('tooBig') ? t('backup.tooBig') : e instanceof Error ? e.message : String(e));
    }
  });

  const openList = () => work(async () => {
    setList((await listBackups().catch(e => { console.error(e); return []; })).filter(countsOk));
  });

  const restoreFrom = (path: string | null) => work(async () => {
    setList(null);
    if (!path) return;
    let c;
    try { c = await openBackup(path); } catch (e) {
      console.error(e);
      await dialog.alert(t('restore.cantTitle'), describe(e));
      return;
    }
    const ok = await dialog.confirm(t('restore.confirmTitle'), t('restore.confirmBody', {
      date: when(c.manifest.createdAt, lang), videos: c.manifest.videos, cards: c.manifest.cards, nowVideos: c.now.videos, nowCards: c.now.cards,
    }), { ok: t('restore.confirmOk'), danger: true });
    if (!ok) { await cancelBackup(); return; }
    try { await startRestore(c); } catch (e) {
      console.error(e);
      await cancelBackup();
      await dialog.alert(t('restore.cantTitle'), describe(e));
    }
  });

  const folder = IS_WINDOWS ? (lang === 'zh' ? '视频' : 'Videos') : (lang === 'zh' ? '影片' : 'Movies');
  return (
    <div className="mt-12 text-center text-xs text-mute">
      <p>
        {t('backup.title')}
        {' · '}
        {auto.failed ? t('backup.autoFailed') : auto.last ? t('backup.lastAuto', { when: when(auto.last, lang) }) : t('backup.noAuto')}
      </p>
      <div className="mt-3 flex justify-center gap-2">
        <Btn size="sm" disabled={busy} onClick={backup}>{t('backup.save')}</Btn>
        <Btn size="sm" disabled={busy} onClick={openList}>{t('backup.restore')}</Btn>
      </div>
      <p className="mt-3 mx-auto max-w-md leading-relaxed">{t('backup.hint', { folder })}</p>

      {list && (
        <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4 fade-in" onClick={() => setList(null)}>
          <Card className="w-full max-w-md shadow-lift text-left" role="dialog" aria-modal="true" aria-label={t('restore.pickTitle')} onClick={e => e.stopPropagation()}>
            <div className="px-6 pt-6 pb-3">
              <h3 className="text-xl font-semibold leading-tight text-ink">{t('restore.pickTitle')}</h3>
              <p className="mt-3 text-xs font-semibold tracking-wider text-mute uppercase">{t('restore.recent')}</p>
            </div>
            <div className="px-3 max-h-72 overflow-y-auto">
              {list.length === 0 && <p className="px-3 pb-2 text-sm text-mute">{t('restore.none')}</p>}
              {list.map(l => (
                <button
                  key={l.path}
                  type="button"
                  onClick={() => restoreFrom(l.path)}
                  className="w-full px-3 py-2.5 rounded-lg flex items-baseline justify-between gap-3 text-sm text-ink text-left hover:bg-shade"
                >
                  <span>
                    {when(l.manifest.createdAt, lang)}
                    {kindOf(l.path) === 'pre' && <span className="ml-2 text-xs text-mute">{t('restore.preTag')}</span>}
                  </span>
                  <span className="text-xs text-mute">{t('restore.item', { videos: l.manifest.videos, cards: l.manifest.cards })}</span>
                </button>
              ))}
            </div>
            <div className="px-6 pt-4 pb-6 flex justify-end">
              <Btn onClick={() => { void pickBackupFile().then(restoreFrom, console.error); }}>{t('restore.pickFile')}</Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default BackupRow;
