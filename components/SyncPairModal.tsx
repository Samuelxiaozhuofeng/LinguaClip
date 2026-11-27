import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Btn, Card } from './ui';
import { useT } from '../utils/i18n';
import { encodePairCode, type WebDavConfig } from '../utils/syncConfig';
import { qrMatrix } from '../utils/qr';
import type { SafetyAlert } from '../utils/syncTypes';

// Pure React SVG QR code (zero dangerouslySetInnerHTML, 100% CSP safe) + pairing code copy modal.
export const SyncPairModal: React.FC<{ config: WebDavConfig; onClose: () => void }> = ({ config, onClose }) => {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const code = useMemo(() => encodePairCode(config), [config]);
  const qr = useMemo(() => {
    try {
      const mat = qrMatrix(code);
      const n = mat.length;
      const quiet = 4;
      const total = n + quiet * 2;
      const parts: string[] = [];
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) if (mat[r][c]) parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
      return { total, path: parts.join('') };
    } catch {
      return null;
    }
  }, [code]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      try {
        const el = document.createElement('textarea');
        el.value = code;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setCopied(true);
      } catch {
        // clipboard unavailable
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[95] bg-black/40 flex items-center justify-center p-4 fade-in"
      onClick={onClose}
    >
      <Card
        data-testid="sync-pair-dialog"
        className="w-full max-w-md shadow-lift text-left"
        role="dialog"
        aria-modal="true"
        aria-label={t('sync.pairTitle')}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-2">
          <h3 className="text-xl font-semibold leading-tight text-ink">{t('sync.pairTitle')}</h3>
          <p className="mt-2 text-sm text-mute leading-relaxed">{t('sync.pairDesc')}</p>
        </div>

        <div className="px-6 py-4 flex flex-col items-center gap-4">
          {qr && (
            <svg
              viewBox={`0 0 ${qr.total} ${qr.total}`}
              className="w-52 h-52 rounded-xl border border-line bg-white"
              shapeRendering="crispEdges"
              role="img"
              aria-label={t('sync.pairTitle')}
            >
              <rect width={qr.total} height={qr.total} fill="#fff" />
              <path d={qr.path} fill="#111" />
            </svg>
          )}
          <Btn tone="accent" onClick={() => { void copyCode(); }}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {t(copied ? 'sync.pairCopied' : 'sync.pairCopy')}
          </Btn>
          <p className="text-xs text-mute text-center leading-relaxed bg-shade rounded-xl px-3.5 py-2.5 w-full">
            {t('sync.pairWarn')}
          </p>
        </div>

        <div className="px-6 pt-1 pb-6 flex justify-end">
          <Btn onClick={onClose}>{t('sync.close')}</Btn>
        </div>
      </Card>
    </div>
  );
};

// First-sync / mass-deletion safety confirmation modal (blocks Esc/backdrop while merging).
export const SyncConfirmModal: React.FC<{
  alert: SafetyAlert;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ alert, busy, onConfirm, onCancel }) => {
  const t = useT();
  const isMass = alert.kind === 'massDeletion' || alert.massDeletion;
  const title = t(isMass ? 'sync.massDelTitle' : 'sync.firstSyncTitle');
  const body = isMass
    ? t('sync.massDelBody', {
      dropV: alert.dropVideos,
      dropC: alert.dropCards,
      localVideos: alert.localVideos,
      localCards: alert.localCards,
    })
    : t('sync.firstSyncBody', {
      localVideos: alert.localVideos,
      localCards: alert.localCards,
      addV: alert.summary.addedVideos,
      addC: alert.summary.addedCards,
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!busy) onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[96] bg-black/40 flex items-center justify-center p-4 fade-in"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <Card
        data-testid="sync-confirm-dialog"
        className="w-full max-w-md shadow-lift text-left"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-2">
          <h3 className="text-xl font-semibold leading-tight text-ink">{title}</h3>
        </div>
        <p className="px-6 pb-5 text-sm text-mute leading-relaxed whitespace-pre-line">{body}</p>
        <div className="px-6 pt-1 pb-6 flex justify-end gap-3">
          <Btn disabled={busy} onClick={onCancel}>{t('sync.cancel')}</Btn>
          <Btn tone={isMass ? 'ink' : 'accent'} disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            {t('sync.confirmMergeOk')}
          </Btn>
        </div>
      </Card>
    </div>
  );
};
