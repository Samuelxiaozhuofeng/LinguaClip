import React from 'react';
import { Check, Eye, EyeOff, Flag, Headphones } from 'lucide-react';
import type { Subtitle, VideoRecord } from '../types';
import { Btn, Card } from '../components/ui';
import { t as tr, useT, type DictKey } from '../utils/i18n';
import { recordRate, showLang, suggestShows, type Heard, type Rate, type Way } from './listenLevel';
import type { Pick } from './podcastShows';

// The listening page's coaching: the three
// steps' bar and the card that explains them, the blind screen with "see this line", the card
// between two steps, and "how much did you follow" with its easier / harder show hint.

export const rateText = (r: Rate, t: typeof tr) =>
  t(r.unit === 'word' ? 'listen.rate_word' : 'listen.rate_char', { n: r.n }) + (r.tier ? ` · ${t(`listen.tier_${r.tier}` as DictKey)}` : '');
export const podcastRate = (r: VideoRecord): string | null => { const x = recordRate(r); return x ? rateText(x, tr) : null; };

// Listening blind: the cover, which line of the section this is (a cell each — a click plays
// from there; a hard one stands taller), "mark hard" (S), and the one line asked for with V,
// shown until playback moves to another.
export const ListenBlind: React.FC<{
  image?: string; lines: Subtitle[]; at: number; marked: Set<number>; peek: React.ReactNode | null; hint: string | null;
  onPick: (l: Subtitle) => void; onPeek: () => void; onMark: () => void;
}> = ({ image, lines, at, marked, peek, hint, onPick, onPeek, onMark }) => {
  const t = useT();
  return (
    <div className="h-full overflow-y-auto flex flex-col items-center justify-center gap-6 px-8 py-6 text-center">
      <span className="relative shrink-0 w-[184px] h-[184px] rounded-[20px] bg-page shadow-card overflow-hidden flex items-center justify-center text-faint">
        <Headphones size={64} strokeWidth={1.5} />
        {image && <img src={image} alt="" className="absolute inset-0 w-full h-full object-cover" onError={e => { e.currentTarget.style.display = 'none'; }} />}
      </span>
      <p className="text-[15px] text-mute">{t('listen.lineOf', { n: Math.max(0, at) + 1, total: lines.length })}</p>
      <div className="max-w-[640px] flex flex-wrap justify-center items-end">
        {lines.map((l, k) => (
          <button key={l.id} type="button" onClick={() => onPick(l)} title={t('listen.fromLine', { n: k + 1 })} aria-label={t('listen.fromLine', { n: k + 1 })}
            className="group h-7 px-[2.5px] flex items-end">
            <span className={`block w-2.5 rounded-[3px] group-hover:opacity-60 ${k === at ? 'h-5 bg-accent' : marked.has(l.id) ? 'h-4' : 'h-2.5'} ${k === at ? '' : k < at ? 'bg-ink' : 'bg-line'}`} />
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Btn size="sm" tone={peek ? 'accent-soft' : 'white'} aria-pressed={!!peek} onClick={e => { e.currentTarget.blur(); onPeek(); }} title={t('listen.peekTitle')}>
          {peek ? <EyeOff size={14} /> : <Eye size={14} />}{peek ? t('listen.peekHide') : t('listen.peek')}
        </Btn>
        {at >= 0 && (
          <Btn size="sm" tone={marked.has(lines[at].id) ? 'accent-soft' : 'white'} aria-pressed={marked.has(lines[at].id)} onClick={e => { e.currentTarget.blur(); onMark(); }} title={t('listen.markTitle')}>
            <Flag size={14} />{t('listen.mark')}
          </Btn>
        )}
      </div>
      {peek ? <div className="w-full max-w-[820px] text-left">{peek}</div>
        : hint && <p className="max-w-[520px] px-5 py-4 rounded-2xl bg-page border border-line text-sm leading-relaxed text-mute">{hint}</p>}
    </div>
  );
};

// "How much did you follow?" — answered once per section (the page keeps the answer, so
// the card / summary shows it again rather than asking twice); two "little" / three "most"
// in a row for this show bring the hint and up to two recommended shows (a click opens that
// show's episodes).
export type Said = { a: Heard; way: Way | null };
export const HeardAsk: React.FC<{ record: VideoRecord; said?: Said; onAnswer: (a: Heard) => void; onShow: (p: Pick) => void }> = ({ record, said, onAnswer, onShow }) => {
  const t = useT();
  const answer = (a: Heard) => { if (!said) onAnswer(a); };
  const picks = said?.way ? suggestShows(said.way, record.podcast?.feed, showLang(record)) : [];
  return (
    <section className="flex flex-col gap-2.5 pb-1">
      <div className="flex items-center gap-3 flex-wrap">
        <p className="text-sm font-medium">{t('listen.heardAsk')}</p>
        <div className="flex gap-1.5">
          {(['most', 'half', 'little'] as Heard[]).map(a => (
            <Btn key={a} size="sm" tone={said?.a === a ? 'accent-soft' : 'white'} aria-pressed={said?.a === a} disabled={!!said && said.a !== a} onClick={e => { e.currentTarget.blur(); answer(a); }}>
              {t(`listen.heard_${a}` as DictKey)}
            </Btn>
          ))}
        </div>
      </div>
      {said && !said.way && <p className="text-[13px] text-mute">{t('listen.heardNoted')}</p>}
      {said?.way && (
        <div className="px-4 py-3 rounded-xl bg-shade text-[13px] leading-relaxed flex flex-col gap-2">
          <p>{t(said.way === 'easier' ? 'listen.hintEasier' : 'listen.hintHarder')}</p>
          {picks.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-mute">{t('listen.hintTry')}</span>
              {picks.map(p => (
                <Btn key={p.id} size="sm" onClick={() => onShow(p)}>
                  {p.name}<span className="text-xs text-mute">{t(`podcast.level_${p.level}` as DictKey)}{p.slow ? ` · ${t('podcast.slow')}` : ''}</span>
                </Btn>
              ))}
            </div>
          )}
          {said.way === 'easier' && <p className="text-mute">{t('listen.hintSlow')}</p>}
        </div>
      )}
    </section>
  );
};

// After the blind listen: paused at the section's end until the main button (or play, which
// starts step 2 — the hard lines, or with none marked the whole transcript). Esc / a click
// outside only closes it. It asks how much was followed; "most" with nothing marked makes
// moving on the main way.
export const PassCard: React.FC<{
  ask: React.ReactNode | null; on: string | null; // `on`: the main button's label when moving on
  hard: number; // lines marked hard that step 2 plays (0: the whole transcript)
  onStart: () => void; onOn: () => void; onClose: () => void;
}> = ({ ask, on, hard, onStart, onOn, onClose }) => {
  const t = useT();
  const title = t('listen.stepDone_1');
  const start = hard ? t('listen.stepStart_drill', { n: hard }) : t('listen.stepStart_2');
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4 fade-in" onClick={onClose}>
      <Card className="w-full max-w-lg p-6 flex flex-col gap-4 shadow-lift" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <h3 className="text-xl font-semibold leading-tight">{title}</h3>
        {ask}
        {!on && <p className="text-[15px] leading-relaxed">{hard ? t('listen.passNext_drill', { n: hard }) : t('listen.passNext_2')}</p>}
        <div className="flex items-center gap-2">
          <span className="mr-auto text-xs text-mute">{t('listen.passKey')}</span>
          {on ? <>
            <Btn onClick={onStart}>{t('listen.anyway')}</Btn>
            <Btn tone="accent" onClick={onOn}>{on}</Btn>
          </> : <Btn tone="accent" onClick={onStart}>{start}</Btn>}
        </div>
      </Card>
    </div>
  );
};

// The three steps of a section: the one under way lit, the ones before ticked; a click goes
// to that step (1–2 from the section's start / first hard line, 3 the section's summary). "?" shows the card again.
export const StepBar: React.FC<{ step: number; onStep: (n: number) => void; onHelp: () => void }> = ({ step, onStep, onHelp }) => {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      {[1, 2, 3].map(n => (
        <button key={n} type="button" onClick={e => { e.currentTarget.blur(); onStep(n); }} title={t('listen.stepsTitle')} aria-current={n === step ? 'step' : undefined}
          className={`press h-8 px-3 rounded-full text-[13px] whitespace-nowrap flex items-center gap-1 ${n === step ? 'bg-accent-soft text-accent font-semibold' : n < step ? 'text-ink hover:bg-shade' : 'text-mute hover:bg-shade'}`}>
          {n < step ? <Check size={13} /> : <span className="tabular-nums">{n}</span>}{t(`listen.step_${n}` as DictKey)}
        </button>
      ))}
      <button type="button" onClick={e => { e.currentTarget.blur(); onHelp(); }} title={t('listen.introTitle')} aria-label={t('listen.introTitle')}
        className="press ml-1 w-7 h-7 rounded-full border border-line text-mute text-[13px] hover:bg-shade">?</button>
    </div>
  );
};

// What the three steps are: shown the first time an episode opens (playback waits for it) and on "?".
// Any way of closing it counts as seen and starts playing.
export const IntroCard: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useT();
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4 fade-in" onClick={onClose}>
      <Card className="w-full max-w-lg p-6 flex flex-col gap-4 shadow-lift" role="dialog" aria-modal="true" aria-label={t('listen.introTitle')} onClick={e => e.stopPropagation()}>
        <h3 className="text-xl font-semibold leading-tight">{t('listen.introTitle')}</h3>
        <p className="text-sm text-mute">{t('listen.introBody')}</p>
        <ol className="flex flex-col gap-2.5">
          {[1, 2, 3].map(n => (
            <li key={n} className="flex gap-3 text-[15px] leading-relaxed">
              <span className="shrink-0 w-6 h-6 mt-0.5 rounded-full bg-accent-soft text-accent text-[13px] font-semibold flex items-center justify-center">{n}</span>
              <span><span className="font-semibold">{t(`listen.step_${n}` as DictKey)}</span>　{t(`listen.introStep_${n}` as DictKey)}</span>
            </li>
          ))}
        </ol>
        <p className="text-[13px] text-mute leading-relaxed">{t('listen.introFoot')}</p>
        <div className="flex justify-end"><Btn tone="accent" onClick={onClose} autoFocus>{t('listen.introStart')}</Btn></div>
      </Card>
    </div>
  );
};

// Step 2 on the hard lines: which one this is, and — stopped at its end — again without the
// text, or how it went (either goes on to the next).
export const DrillBar: React.FC<{ n: number; total: number; onHide: () => void; onDone: (ok: boolean) => void }> = ({ n, total, onHide, onDone }) => {
  const t = useT();
  return (
    <div className="absolute left-1/2 -translate-x-1/2 bottom-5 z-10 flex items-center gap-2 pl-4 pr-2 py-2 rounded-full bg-page border border-line shadow-card">
      <span className="text-[13px] text-mute whitespace-nowrap tabular-nums mr-1">{t('listen.drillOf', { n, total })}</span>
      <Btn size="sm" onClick={e => { e.currentTarget.blur(); onHide(); }}><EyeOff size={14} />{t('listen.drillHide')}</Btn>
      <Btn size="sm" onClick={e => { e.currentTarget.blur(); onDone(false); }}>{t('listen.drillMore')}</Btn>
      <Btn size="sm" tone="accent" onClick={e => { e.currentTarget.blur(); onDone(true); }}>{t('listen.drillOk')}</Btn>
    </div>
  );
};
