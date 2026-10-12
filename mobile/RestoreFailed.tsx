// Shown instead of the phone app while a restore hasn't finished (mobile/restore.ts):
// try again, go back to the copy saved before the restore, or give up on purpose.
import React, { useState } from 'react';
import { useT } from '../utils/i18n';
import type { Pending } from './backup';
import { abandonRestore, currentPending, describe, restorePre, retryRestore } from './restore';
import { btnPlain, btnPrimary } from './ui';

export const RestoreFailed: React.FC<{ pending: Pending | null; error: string | null }> = ({ pending: first, error }) => {
  const t = useT();
  const [why, setWhy] = useState(error);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(first);
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) {
      console.error(e);
      setWhy(describe(e));
      setPending(currentPending()); // "use" may now be the before-restore copy
    } finally { setBusy(false); }
  };
  return (
    <div role="alertdialog" aria-label={t('restore.failedTitle')}
      className="min-h-[100dvh] flex flex-col justify-center gap-4 px-6 pt-[env(safe-area-inset-top)] pb-[max(20px,env(safe-area-inset-bottom))]">
      <h1 className="text-[22px] font-semibold">{t('restore.failedTitle')}</h1>
      <p className="text-[15px] text-mute whitespace-pre-line">{why ? t('restore.failedBody', { why }) : t('restore.interrupted')}</p>
      <p className="text-[13px] text-mute">{t('restore.halfDone')}</p>
      <div className="flex flex-col gap-2.5 mt-2">
        {pending && <button className={btnPrimary} disabled={busy} onClick={act(retryRestore)}>{t('restore.retry')}</button>}
        {pending && pending.use !== 'pre' && <button className={btnPlain} disabled={busy} onClick={act(restorePre)}>{t('restore.back')}</button>}
        <button className={btnPlain} disabled={busy} onClick={act(abandonRestore)}>{t('restore.abandon')}</button>
      </div>
    </div>
  );
};
