// Sticky mini playback bar at the top of the phone's "Read first" (先读字幕) page (M2.3).
// Shows ▶/❚❚ circular button, "第 i 句", single-line / continuous switch, speed cycler,
// and compact toggles for translations / Japanese furigana. All controls ≥44px touch targets.
import React from 'react';
import { useT } from '../../utils/i18n';
import type { ReadPlayMode } from './useReaderPlayer';

const RATES = [0.75, 0.9, 1, 1.25, 1.5, 2] as const;

export const MiniPlayerBar: React.FC<{
  lineNum: number;
  total: number;
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
}> = ({
  lineNum,
  total,
  playing,
  disabled,
  noAudio = false,
  mode,
  rate,
  ja,
  kana,
  showTrans,
  hasTrans,
  onToggle,
  onModeChange,
  onRateChange,
  onKanaToggle,
  onTransToggle,
}) => {
  const t = useT();
  if (noAudio && !ja && !hasTrans) return null;

  const nextRate = () => {
    const idx = RATES.indexOf(rate as (typeof RATES)[number]);
    onRateChange(RATES[(idx + 1) % RATES.length]);
  };

  return (
    <div
      data-testid="reader-mini-bar"
      className="sticky top-0 z-20 px-4 py-2 bg-paper/95 backdrop-blur-sm border-b border-shade flex items-center gap-2 shrink-0"
    >
      {!noAudio && (
        <button
          type="button"
          disabled={disabled}
          onClick={onToggle}
          aria-label={t(playing ? 'm.pause' : 'm.play')}
          className="w-11 h-11 shrink-0 rounded-full bg-ink text-white flex items-center justify-center disabled:opacity-40 active:scale-95 transition-transform"
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

      <div className="min-w-0 flex-1 flex items-center gap-1.5">
        <span className="text-[13px] font-medium text-ink tabular-nums truncate">
          {total > 0 ? t('m.readLineN', { n: Math.max(1, lineNum) }) : '—'}
        </span>
      </div>

      {!noAudio && (
        <>
          <div
            className="inline-flex items-center bg-page rounded-full p-0.5 shadow-card shrink-0"
            role="group"
            aria-label={t('m.readSingle')}
          >
            <button
              type="button"
              aria-pressed={mode === 'single'}
              onClick={() => onModeChange('single')}
              className={`min-h-[40px] px-2.5 rounded-full text-xs whitespace-nowrap ${
                mode === 'single' ? 'bg-accent-soft text-accent font-medium' : 'text-mute'
              }`}
            >
              {t('m.readSingle')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'continuous'}
              onClick={() => onModeChange('continuous')}
              className={`min-h-[40px] px-2.5 rounded-full text-xs whitespace-nowrap ${
                mode === 'continuous' ? 'bg-accent-soft text-accent font-medium' : 'text-mute'
              }`}
            >
              {t('m.readContinuous')}
            </button>
          </div>

          <button
            type="button"
            onClick={nextRate}
            aria-label={t('m.speed')}
            className="min-w-[44px] min-h-[44px] px-2 rounded-full bg-page shadow-card text-xs font-medium text-ink tabular-nums shrink-0"
          >
            {rate === 1 ? '1.0' : rate}×
          </button>
        </>
      )}

      {ja && (
        <button
          type="button"
          aria-pressed={kana}
          onClick={onKanaToggle}
          className={`min-w-[44px] min-h-[44px] px-2 rounded-full text-xs shrink-0 ${
            kana ? 'bg-ink text-white font-medium' : 'bg-page shadow-card text-mute'
          }`}
        >
          {t('m.readKana')}
        </button>
      )}

      {hasTrans && (
        <button
          type="button"
          aria-pressed={showTrans}
          onClick={onTransToggle}
          className={`min-w-[44px] min-h-[44px] px-2 rounded-full text-xs shrink-0 ${
            showTrans ? 'bg-ink text-white font-medium' : 'bg-page shadow-card text-mute'
          }`}
        >
          {t('m.readTrans')}
        </button>
      )}
    </div>
  );
};
