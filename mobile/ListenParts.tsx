// The listening page's pieces (design Listen.dc.html): the three steps' bar, the blind
// screen, step 2's hard-line bar, the card after listening blind ("how much did you
// follow" and what comes next) and the section's summary (hard lines into review,
// starred lines, words looked up).
import React from 'react';
import type { Subtitle } from '../types';
import { useT, type DictKey } from '../utils/i18n';
import type { Heard, Way } from '../pro/listenLevel';
import { btnPlain, btnPrimary } from './ui';
import { useBackClose } from './backClose';

export const StepBar: React.FC<{ step: number; onStep: (n: number) => void; className?: string }> = ({ step, onStep, className = 'mx-5 mt-1' }) => {
  const t = useT();
  return (
    <div className={`${className} grid grid-cols-3 gap-1.5`}>
      {[1, 2, 3].map(n => (
        <button key={n} onClick={() => onStep(n)} aria-current={n === step ? 'step' : undefined} className="min-h-[44px] flex flex-col justify-center gap-1.5 text-left">
          <span className={`h-1 rounded ${n <= step ? 'bg-accent' : 'bg-line'}`} />
          <span className={`text-xs ${n === step ? 'font-semibold' : 'text-mute'}`}>{n} {t(`listen.step_${n}` as DictKey)}</span>
        </button>
      ))}
    </div>
  );
};

export const Blind: React.FC<{
  lines: Subtitle[];
  at: number;
  marked: Set<number>;
  hint: string | null;
  embedded?: boolean;
  multiSection?: boolean;
}> = ({ lines, at, marked, hint, embedded = false, multiSection = false }) => {
  const t = useT();
  const n = lines.filter(l => marked.has(l.id)).length;
  const lineLabel = !embedded
    ? t('m.lineOf', { n: Math.max(0, at) + 1, total: lines.length })
    : multiSection
      ? t('m.w1SecLineOf', { n: Math.max(0, at) + 1, total: lines.length })
      : null;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-[18px] px-7 text-center">
      {hint && <p className="text-[13px] text-mute">{hint}</p>}
      <div className="flex flex-wrap justify-center items-end gap-[5px] min-h-9" aria-hidden>
        {lines.map((l, k) => (
          <span key={l.id} className={`w-1 rounded-sm ${k === at ? 'h-9 bg-accent' : marked.has(l.id) ? 'h-6 bg-accent/70' : k < at ? 'h-3.5 bg-mute' : 'h-3.5 bg-faint'}`} />
        ))}
      </div>
      {lineLabel && <p className="text-[15px] text-mute">{lineLabel}</p>}
      {n > 0 && <p className="text-[13px] text-mute bg-page rounded-full px-3 py-1.5">{t('m.markedN', { n })}</p>}
    </div>
  );
};

export const DrillBar: React.FC<{ n: number; total: number; play: number; tries: number; shown: boolean; onShow: () => void; onNext: () => void }> = ({ n, total, play, tries, shown, onShow, onNext }) => {
  const t = useT();
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-center text-[13px] text-mute tabular-nums">{t('listen.drillOf', { n, total })}{!shown && ` · ${t('listen.drillPlay', { n: play, total: tries })}`}</p>
      <div className={`grid ${shown ? 'grid-cols-1' : 'grid-cols-[1fr_2fr]'} gap-2.5`}>
        {!shown && <button className={btnPlain} onClick={onShow}>{t('m.showText')}</button>}
        <button className={`${btnPrimary} h-16 text-[17px]`} onClick={onNext}>{t(shown ? 'm.drillNext' : 'm.drillGot')}</button>
      </div>
    </div>
  );
};

const Sheet: React.FC<{ label: string; onClose: () => void; children: React.ReactNode }> = ({ label, onClose, children }) => {
  const t = useT();
  useBackClose(true, onClose);
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end" role="dialog" aria-label={label}>
      <button aria-label={t('m.close')} className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative max-h-[88vh] supports-[height:1dvh]:max-h-[88dvh] overflow-y-auto bg-page rounded-t-[22px] shadow-lift px-5 pt-5 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-4">
        <h2 className="text-xl font-semibold">{label}</h2>
        {children}
      </div>
    </div>
  );
};

export const HeardAsk: React.FC<{ said?: { a: Heard; way: Way | null }; onAnswer: (a: Heard) => void }> = ({ said, onAnswer }) => {
  const t = useT();
  return (
    <section className="flex flex-col gap-2.5">
      <p className="text-sm font-medium">{t('listen.heardAsk')}</p>
      <div className="grid grid-cols-3 gap-2">
        {(['most', 'half', 'little'] as Heard[]).map(a => (
          <button key={a} aria-pressed={said?.a === a} disabled={!!said && said.a !== a} onClick={() => onAnswer(a)}
            className={`min-h-[44px] rounded-[10px] text-sm disabled:opacity-40 ${said?.a === a ? 'bg-accent-soft text-accent font-semibold' : 'bg-shade'}`}>
            {t(`listen.heard_${a}` as DictKey)}
          </button>
        ))}
      </div>
      {said?.way && <p className="text-[13px] text-mute leading-relaxed">{t(said.way === 'easier' ? 'listen.hintEasier' : 'listen.hintHarder')}</p>}
    </section>
  );
};

// After the blind listen. `on`: moving on is the main way (followed most, nothing marked).
export const PassSheet: React.FC<{ ask: React.ReactNode; hard: number; on: string | null; onStart: () => void; onOn: () => void; onClose: () => void }> = ({ ask, hard, on, onStart, onOn, onClose }) => {
  const t = useT();
  return (
    <Sheet label={t('listen.stepDone_1')} onClose={onClose}>
      {ask}
      {!on && <p className="text-[15px] leading-relaxed">{hard ? t('m.passNextDrill', { n: hard }) : t('listen.passNext_2')}</p>}
      {on ? (
        <div className="grid grid-cols-2 gap-2.5">
          <button className={btnPlain} onClick={onStart}>{t('listen.anyway')}</button>
          <button className={btnPrimary} onClick={onOn}>{on}</button>
        </div>
      ) : <button className={btnPrimary} onClick={onStart}>{hard ? t('listen.stepStart_drill', { n: hard }) : t('listen.stepStart_2')}</button>}
    </Sheet>
  );
};

export type Looked = { word: string; key: string; kept: boolean; can: boolean };
export type SummaryMissed = { line: Subtitle; saved: boolean; removed: boolean };

// The summary: hard lines are already in review (can be removed with undo); starred lines
// stay in review; words looked up can be kept.
export const Summary: React.FC<{
  title: string; missed: SummaryMissed[]; saved: Subtitle[]; words: Looked[];
  onward: boolean;
  onRemoveMissed: (line: Subtitle) => void; onUndoMissed: (line: Subtitle) => void;
  onKeep: (key: string) => void; onAgain: () => void; onNext: () => void; onHome: () => void; onClose: () => void;
}> = ({ title, missed, saved, words, onward, onRemoveMissed, onUndoMissed, onKeep, onAgain, onNext, onHome, onClose }) => {
  const t = useT();
  const activeMissed = missed.filter(m => !m.removed).length;
  return (
    <Sheet label={title} onClose={onClose}>
      {missed.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="text-[13px] text-mute">{t('m.w1MissedHead', { n: activeMissed })}</p>
          {missed.map(m => (
            <div key={m.line.id} className="min-h-[44px] flex items-start gap-2.5 py-1.5 border-b border-shade last:border-0">
              <div className="flex-1 min-w-0">
                <p className={`font-serif text-[16px] leading-snug ${m.removed ? 'line-through text-mute' : ''}`}>
                  {m.saved ? '★ ' : ''}{m.line.text}
                </p>
                {m.removed && <p className="text-xs text-mute mt-0.5">{t('m.w1RemovedReview')}</p>}
              </div>
              {m.removed ? (
                <button
                  type="button"
                  onClick={() => onUndoMissed(m.line)}
                  className="shrink-0 min-h-[44px] px-3 rounded-[10px] bg-accent-soft text-accent text-[13px] font-medium active:opacity-80"
                >
                  {t('review.undo')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onRemoveMissed(m.line)}
                  className="shrink-0 min-h-[44px] px-3 rounded-[10px] bg-shade text-mute text-[13px] active:bg-line"
                >
                  {t('m.w1RemoveReview')}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {saved.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="text-[13px] text-mute">{t('m.savedHead', { n: saved.length })}</p>
          {saved.map(l => <p key={l.id} className="font-serif text-[16px] leading-snug">★ {l.text}</p>)}
        </section>
      )}
      {!missed.length && !saved.length && <p className="text-sm text-mute leading-relaxed">{t('m.w1SummaryEmpty')}</p>}
      {words.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="text-[13px] text-mute">{t('m.lookedHead')}</p>
          <div className="flex flex-wrap gap-2">
            {words.map(w => (
              <button key={w.key} disabled={w.kept || !w.can} onClick={() => onKeep(w.key)}
                className={`min-h-[44px] px-3 rounded-[10px] text-sm ${w.kept ? 'bg-accent-soft text-accent' : 'bg-shade'} disabled:opacity-60`}>
                {w.word} {w.kept ? '✓' : w.can ? '＋' : ''}
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <button className={btnPlain} onClick={onAgain}>{t('listen.again')}</button>
        {onward ? <button className={btnPlain} onClick={onNext}>{t('listen.next')}</button> : <button className={btnPlain} onClick={onHome}>{t('m.toHome')}</button>}
      </div>
    </Sheet>
  );
};
