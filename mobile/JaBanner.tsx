// Shared Japanese splitting dictionary download banner for mobile Study ways
// (docs/android.md「手机学习闭环」· 日语). Mounted once at the top of Study.tsx
// so every practice way offers one-tap kuromoji dictionary installation.
import React from 'react';
import { useT } from '../utils/i18n';
import { downloadJa, useJaState } from '../utils/japanese';

export const JaBanner: React.FC<{ className?: string }> = ({ className = 'mx-4 mb-2' }) => {
  const t = useT();
  const s = useJaState();
  if (s.ready || s.installed === null || (s.installed && !s.failed)) return null;
  return (
    <button
      type="button"
      data-testid="ja-dict-banner"
      disabled={s.running}
      onClick={() => { void downloadJa(); }}
      className={`${className} min-h-[44px] px-3.5 py-2 rounded-xl bg-page shadow-card text-[13px] text-left text-ink disabled:opacity-60`}
    >
      {s.running ? t('ja.downloading', { pct: s.pct }) : s.failed ? t('m.jaFailed') : t('m.jaDownload')}
    </button>
  );
};
