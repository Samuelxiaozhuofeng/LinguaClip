// Floating play pill at the bottom-right of the phone's "Read first" (先读字幕) page, plus the
// "Playback & display" sheet it opens (docs/android.md「沉浸阅读」). Replaces the old sticky top bar so
// the subtitles get the whole screen: the pill = ▶/❚❚ + a ⋯ button that also shows non-default state
// (continuous / speed); the sheet = single-line vs continuous, speed, translations, Japanese kana.
import React, { useState } from 'react';
import { useT } from '../../utils/i18n';
import { useBackClose } from '../backClose';
import type { ReadPlayMode } from './useReaderPlayer';

const RATES = [0.75, 0.9, 1, 1.25, 1.5, 2] as const;
const rateText = (r: number) => `${r}×`;

const Chip: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode; label?: string }> = ({ on, onClick, children, label }) => (
  <button
    type="button"
    aria-pressed={on}
    aria-label={label}
    onClick={onClick}
    className={`min-h-[40px] min-w-[44px] px-2 rounded-full text-[13px] whitespace-nowrap tabular-nums ${
      on ? 'bg-ink text-inverse font-medium' : 'bg-page shadow-card text-mute'
    }`}
  >
    {children}
  </button>
);

export const ReaderDock: React.FC<{
  playing: boolean;
  disabled: boolean;
  noAudio?: boolean;
  mode: ReadPlayMode;
  rate: number;
  ja: boolean;
  kana: boolean;
  showTrans: boolean;
  hasTrans: boolean;
  onToggle: () => void;
  onModeChange: (m: ReadPlayMode) => void;
  onRateChange: (r: number) => void;
  onKanaToggle: () => void;
  onTransToggle: () => void;
  /** The sheet opened / closed (the page shows its top bar while the sheet is up). */
  onPanel?: (open: boolean) => void;
  /** Shown at the bottom of the sheet (e.g. "kana needs the Japanese dictionary" + download). */
  extra?: React.ReactNode;
}> = ({
  playing, disabled, noAudio = false, mode, rate, ja, kana, showTrans, hasTrans,
  onToggle, onModeChange, onRateChange, onKanaToggle, onTransToggle, onPanel, extra,
}) => {
  const t = useT();
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean) => { setOpenState(v); onPanel?.(v); };
  useBackClose(open, () => setOpen(false));
  if (noAudio && !ja && !hasTrans) return null;

  // Non-default state stays visible on the pill so the user never has to open the sheet to check.
  const state = [mode === 'continuous' ? t('m.readContinuous') : '', rate !== 1 ? rateText(rate) : '']
    .filter(Boolean).join(' · ');

  return (
    <>
      <div
        data-testid="reader-dock"
        className="absolute right-3 bottom-[max(14px,env(safe-area-inset-bottom))] z-20 flex items-center gap-1 p-1 rounded-full bg-page/95 backdrop-blur-sm shadow-lift"
      >
        {!noAudio && (
          <button
            type="button"
            disabled={disabled}
            onClick={onToggle}
            aria-label={t(playing ? 'm.pause' : 'm.play')}
            className="w-12 h-12 shrink-0 rounded-full bg-ink text-inverse flex items-center justify-center disabled:opacity-40 active:scale-95 transition-transform"
          >
            {playing ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
        )}
        <button
          type="button"
          data-testid="reader-dock-more"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('m.readPanel')}
          onClick={() => setOpen(true)}
          className="min-w-[44px] h-12 px-3 rounded-full text-mute text-[13px] flex items-center justify-center gap-1.5 tabular-nums"
        >
          {state && <span className="text-accent font-medium whitespace-nowrap">{state}</span>}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={t('m.readPanel')}>
          <button type="button" aria-label={t('m.close')} className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div
            data-testid="reader-panel"
            className="relative max-h-[80vh] supports-[height:1dvh]:max-h-[80dvh] overflow-y-auto bg-paper rounded-t-[22px] shadow-lift px-4 pt-5 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-4"
          >
            <h2 className="text-[17px] font-semibold">{t('m.readPanel')}</h2>
            {!noAudio && (
              <>
                <div className="flex items-center gap-2 flex-wrap" role="group">
                  <Chip on={mode === 'single'} onClick={() => onModeChange('single')}>{t('m.readSingle')}</Chip>
                  <Chip on={mode === 'continuous'} onClick={() => onModeChange('continuous')}>{t('m.readContinuous')}</Chip>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label={t('m.speed')}>
                  {RATES.map(r => (
                    <Chip key={r} on={rate === r} onClick={() => onRateChange(r)}>{rateText(r)}</Chip>
                  ))}
                </div>
              </>
            )}
            {(hasTrans || ja) && (
              <div className="flex items-center gap-2 flex-wrap">
                {hasTrans && <Chip on={showTrans} onClick={onTransToggle}>{t('m.readTrans')}</Chip>}
                {ja && <Chip on={kana} onClick={onKanaToggle}>{t('m.readKana')}</Chip>}
              </div>
            )}
            {extra}
          </div>
        </div>
      )}
    </>
  );
};
