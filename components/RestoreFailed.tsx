import React, { useState } from 'react';
import { Btn, Card } from './ui';
import { useT } from '../utils/i18n';
import { abandonRestore, describe, readPending, restorePre, retryRestore } from '../utils/restore';
import type { Pending } from '../utils/backup';

// Shown instead of the app while a restore hasn't finished (utils/restore.ts): try again,
// go back to the copy saved before the restore, or give up on purpose.
const RestoreFailed: React.FC<{ pending: Pending | null; error: string | null }> = ({ pending: first, error }) => {
  const t = useT();
  const [why, setWhy] = useState(error);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(first);
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) {
      console.error(e);
      setWhy(describe(e));
      const now = readPending(); // "use" may have changed to the before-restore copy
      setPending(now === 'unreadable' ? null : now);
    } finally { setBusy(false); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-paper">
      <Card className="w-full max-w-md shadow-lift" role="alertdialog" aria-label={t('restore.failedTitle')}>
        <div className="px-6 pt-6 pb-2">
          <h3 className="text-xl font-semibold leading-tight">{t('restore.failedTitle')}</h3>
        </div>
        <p className="px-6 pb-3 text-sm text-mute leading-relaxed whitespace-pre-line">
          {why ? t('restore.failedBody', { why }) : t('restore.interrupted')}
        </p>
        <p className="px-6 pb-4 text-xs text-mute leading-relaxed">{t('restore.halfDone')}</p>
        <div className="px-6 pt-2 pb-6 flex flex-wrap justify-end gap-3">
          <Btn disabled={busy} onClick={act(abandonRestore)}>{t('restore.abandon')}</Btn>
          {pending?.pre && pending.use !== 'pre' && (
            <Btn disabled={busy} onClick={act(() => restorePre(pending))}>{t('restore.back')}</Btn>
          )}
          {pending && <Btn tone="accent" disabled={busy} onClick={act(() => retryRestore(pending))}>{t('restore.retry')}</Btn>}
        </div>
      </Card>
    </div>
  );
};

export default RestoreFailed;
