// The listening page's pieces (design Listen.dc.html): the three steps' bar, the blind
// screen, step 2's hard-line bar, the card after listening blind ("how much did you
// follow" and what comes next) and the section's summary (hard lines into review,
// starred lines, words looked up).
import React, { useState } from 'react';
import type { Subtitle } from '../types';
import { useT, type DictKey } from '../utils/i18n';
import type { Heard, Way } from '../pro/listenLevel';
import { btnPlain, btnPrimary } from './ui';

export const StepBar: React.FC<{ step: number; onStep: (n: number) => void }> = ({ step, onStep }) => {
  const t = useT();
  return (
    <div className="mx-5 mt-1 grid grid-cols-3 gap-1.5">
      {[1, 2, 3].map(n => (
        <button key={n} onClick={() => onStep(n)} aria-current={n === step ? 'step' : undefined} className="min-h-[44px] flex flex-col justify-center gap-1.5 text-left">
          <span className={`h-1 rounded ${n <= step ? 'bg-accent' : 'bg-line'}`} />
          <span className={`text-xs ${n === step ? 'font-semibold' : 'text-mute'}`}>{n} {t(`listen.step_${n}` as DictKey)}</span>
        </button>
      ))}
    </div>
  );
};

export const Blind: React.FC<{ lines: Subtitle[]; at: number; marked: Set<number>; hint: string | null }> = ({ lines, at, marked, hint }) => {
  const t = useT();
  const n = lines.filter(l => marked.has(l.id)).length;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-[18px] px-7 text-center">
      {hint && <p className="text-[13px] text-mute">{hint}</p>}
      <div className="flex flex-wrap justify-center items-end gap-[5px] min-h-9" aria-hidden>
        {lines.map((l, k) => (
          <span key={l.id} className={`w-1 rounded-sm ${k === at ? 'h-9 bg-accent' : marked.has(l.id) ? 'h-6 bg-accent/70' : k < at ? 'h-3.5 bg-mute' : 'h-3.5 bg-faint'}`} />
        ))}
      </div>
      <p className="text-[15px] text-mute">{t('m.lineOf', { n: Math.max(0, at) + 1, total: lines.length })}</p>
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
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end" role="dialog" aria-label={label}>
      <button aria-label={t('m.close')} className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative max-h-[88dvh] overflow-y-auto bg-page rounded-t-[22px] shadow-lift px-5 pt-5 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-4">
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

// The summary: hard lines (ticked = needs more work or not worked on) go into review
// with "save"; starred lines are already there; words looked up can be kept.
export const Summary: React.FC<{
  title: string; missed: { line: Subtitle; on: boolean; saved: boolean }[]; saved: Subtitle[]; words: Looked[];
  busy: boolean; fail: boolean; added: boolean; onward: boolean;
  onAdd: (picked: Subtitle[]) => void; onKeep: (key: string) => void; onAgain: () => void; onNext: () => void; onHome: () => void; onClose: () => void;
}> = ({ title, missed, saved, words, busy, fail, added, onward, onAdd, onKeep, onAgain, onNext, onHome, onClose }) => {
  const t = useT();
  const [ticked, setTicked] = useState(() => new Set(missed.filter(m => m.on).map(m => m.line.id)));
  const picked = missed.filter(m => ticked.has(m.line.id)).map(m => m.line);
  const flip = (id: number) => setTicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Sheet label={title} onClose={onClose}>
      {missed.length > 0 && (
        <section className="flex flex-col gap-1">
          <p className="text-[13px] text-mute">{t('listen.missedHead', { n: missed.length })}</p>
          {missed.map(m => (
            <label key={m.line.id} className="min-h-[44px] flex items-start gap-3 py-2">
              <input type="checkbox" className="mt-1 w-5 h-5 accent-accent" checked={ticked.has(m.line.id)} disabled={added} onChange={() => flip(m.line.id)} />
              <span className="font-serif text-[16px] leading-snug">{m.saved ? '★ ' : ''}{m.line.text}</span>
            </label>
          ))}
        </section>
      )}
      {saved.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="text-[13px] text-mute">{t('m.savedHead', { n: saved.length })}</p>
          {saved.map(l => <p key={l.id} className="font-serif text-[16px] leading-snug">★ {l.text}</p>)}
        </section>
      )}
      {!missed.length && !saved.length && <p className="text-sm text-mute leading-relaxed">{t('m.summaryEmpty')}</p>}
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
      {fail && <p role="alert" className="text-sm text-accent">{t('listen.addFail')}</p>}
      {picked.length > 0 && !added && <button className={btnPrimary} disabled={busy} onClick={() => onAdd(picked)}>{t('m.addMissed', { n: picked.length })}</button>}
      {added && <p className="text-sm text-mute">{t('m.addedMissed')}</p>}
      <div className="grid grid-cols-2 gap-2.5">
        <button className={btnPlain} onClick={onAgain}>{t('listen.again')}</button>
        {onward ? <button className={btnPlain} onClick={onNext}>{t('listen.next')}</button> : <button className={btnPlain} onClick={onHome}>{t('m.toHome')}</button>}
      </div>
    </Sheet>
  );
};
