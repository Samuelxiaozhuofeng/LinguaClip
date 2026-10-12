// The phone screens' shared bits (design: mobile-web.md 设计稿): a back header, a
// language strip, button looks, how much of a record was heard, and what an import
// error code means in words.
import React from 'react';
import type { VideoRecord } from '../types';
import { STARTER_FEED } from '../utils/sections';
import { parseSRT } from '../utils/srtParser';
import { getWatchPos } from '../utils/storage';
import { t, useT } from '../utils/i18n';

export const btnPrimary = 'h-[52px] rounded-[14px] bg-accent text-white text-[15px] font-semibold disabled:opacity-50';
export const btnPlain = 'h-[52px] rounded-[14px] bg-page text-ink text-[15px] font-semibold shadow-card disabled:opacity-50';
export const btnSmall = 'min-h-[44px] px-4 rounded-[10px] bg-ink text-white text-sm font-medium disabled:opacity-50';
export const btnSoft = 'min-h-[44px] px-4 rounded-[10px] bg-shade text-ink text-sm font-medium';
export const sheet = 'bg-page rounded-2xl';

export const Header: React.FC<{ title: string; onBack: () => void }> = ({ title, onBack }) => {
  const tr = useT();
  return (
    <div className="pt-4 px-3 pb-2 flex items-center gap-1">
      <button aria-label={tr('m.back')} onClick={onBack} className="w-11 h-11 flex items-center justify-center text-2xl">‹</button>
      <h1 className="text-[17px] font-semibold truncate">{title}</h1>
    </div>
  );
};

export const langName = (l: string, ui: string) => {
  try { return new Intl.DisplayNames([ui === 'zh' ? 'zh-CN' : 'en'], { type: 'language' }).of(l) ?? l; } catch { return l; }
};

export function LangBar<L extends string>({ langs, value, onChange, ui }: { langs: L[]; value: L; onChange: (l: L) => void; ui: string }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1" role="radiogroup">
      {langs.map(l => (
        <button key={l} role="radio" aria-checked={l === value} onClick={() => onChange(l)}
          className={`shrink-0 min-h-[44px] px-3.5 rounded-full text-[13px] ${l === value ? 'bg-ink text-white' : 'bg-page text-mute shadow-card'}`}>
          {langName(l, ui)}
        </button>
      ))}
    </div>
  );
}

// "Heard n%": where listening stopped (linguaclip_watch_pos, as on the desktop) against the
// last line's end; parsed once per record and transcript length.
const ends = new Map<string, number>();
export const heardPct = (r: VideoRecord): number => {
  const key = `${r.id}|${r.subtitleText?.length ?? 0}`;
  if (!ends.has(key)) ends.set(key, parseSRT(r.subtitleText ?? '').reduce((m, l) => Math.max(m, l.endTime), 0));
  const end = ends.get(key)!;
  return end > 0 ? Math.min(100, Math.round((getWatchPos(r.id) / end) * 100)) : 0;
};

export const sourceOf = (r: VideoRecord) =>
  r.podcast?.feed === STARTER_FEED ? t('m.srcStarter') : r.podcast ? t('m.srcPodcast') : t('m.srcFile');

// Error codes from importAudio.ts / transcribe.ts → a sentence.
export function errText(code: string): string {
  if (code === 'file:toolarge') return t('m.errTooBig');
  if (code === 'cloud:nokey') return t('m.errNoKey');
  if (code === 'interrupted') return t('m.errInterrupted');
  if (code === 'audio:missing') return t('m.errMissing');
  if (code === 'cloud:toolarge') return t('m.tooLong');
  if (code === 'cloud:nomedia') return t('m.errNoMedia');
  if (code === 'cloud:key') return t('m.errKey');
  if (code === 'cloud:empty') return t('m.errEmpty');
  if (code.startsWith('cloud:quota')) return t('m.errQuota');
  if (code.startsWith('cloud:denied')) return t('m.errDenied');
  if (code.startsWith('cloud:network')) return t('m.errNetwork');
  return t('m.errOther', { msg: code.replace(/^cloud:/, '').slice(0, 120) });
}
