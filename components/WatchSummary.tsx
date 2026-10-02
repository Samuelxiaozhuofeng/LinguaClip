import React, { useState } from 'react';
import { Check, PenLine, Plus, Star } from 'lucide-react';
import { Subtitle } from '../types';
import { Btn, Card } from './ui';
import { useT } from '../utils/i18n';
import { formatTimeCode } from '../utils/storage';

export type Looked = { word: string; line: Subtitle };

// Keeping looked-up words as word cards from the summary (the reader's; the watch page has none).
export interface KeepWords {
  kept: (w: Looked) => boolean;
  can: (w: Looked) => boolean; // a meaning was found to put on the card
  onKeep: (w: Looked) => void;
  onKeepAll: () => void;
}

// What this watch (or read) left behind: the video's saved lines (tick a few to dictate
// them now) and the words looked up this time. Esc / a click outside only
// closes it — never counts as leaving, dictating or keeping.
const WatchSummary: React.FC<{
  title: string;
  savedEmpty: string;
  saved: Subtitle[];
  looked: Looked[];
  words?: KeepWords;
  actions: React.ReactNode; // the buttons before "dictate"
  top?: React.ReactNode; // above the saved lines (the podcast page asks how much was understood)
  savedHead?: string; // the saved lines' heading, where it isn't "tick a few" (the watch page's: this time's saves)
  tick?: number; // this many saved lines start ticked (the watch page: Enter dictates them)
  pickAll?: boolean; // every saved line starts ticked, and with none there's no dictate button (intensive listening's wrap-up)
  missed?: { line: Subtitle; on: boolean; saved: boolean }[]; // intensive listening's hard lines, above the saved ones (`on`: starts ticked)
  busy?: boolean; // the dictate button waits (adding the hard lines to review)
  onClose: () => void;
  onJump: (line: Subtitle) => void;
  onWord: (w: Looked) => void;
  onDrill: (lines: Subtitle[]) => void;
}> = ({ title, savedEmpty, saved, looked, words, actions, top, savedHead, tick = 0, pickAll, missed = [], busy, onClose, onJump, onWord, onDrill }) => {
  const t = useT();
  const [picked, setPicked] = useState<Set<number>>(() => new Set([...missed.filter(m => m.on).map(m => m.line.id), ...saved.slice(0, pickAll ? saved.length : tick).map(s => s.id)]));
  const toggle = (id: number) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const all = [...missed.map(m => m.line), ...saved];
  const chosen = all.filter(s => picked.has(s.id));
  const row = (s: Subtitle, star = false) => (
    <div key={s.id} className="flex items-start gap-3">
      <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} aria-label={t('watch.pickLine')} className="mt-1.5 w-4 h-4 accent-accent shrink-0" />
      <button type="button" onClick={() => onJump(s)} title={t('watch.jumpTo')} className="min-w-0 flex-1 text-left rounded-lg px-2 py-1 -my-1 hover:bg-shade">
        <span className="font-serif text-[17px] leading-snug">{s.text}</span>
        {star && <Star size={13} className="inline ml-1.5 -mt-1 text-accent fill-current" />}
        <span className="ml-2 text-xs text-mute tabular-nums">{formatTimeCode(s.startTime)}</span>
      </button>
    </div>
  );
  const keepable = words ? looked.filter(w => words.can(w) && !words.kept(w)).length : 0;

  return (
    <div className="fixed inset-0 z-30 bg-black/50 flex items-center justify-center p-4 fade-in" onClick={onClose}>
      <Card className="w-full max-w-xl max-h-[85vh] flex flex-col shadow-lift" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-2">
          <h3 className="text-xl font-semibold leading-tight">{title}</h3>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-2 flex flex-col gap-5">
          {top}
          {missed.length > 0 && (
            <section className="flex flex-col gap-2">
              <p className="text-xs text-mute">{t('listen.missedHead', { n: missed.length })}</p>
              {missed.map(m => row(m.line, m.saved))}
            </section>
          )}
          {!(missed.length && !saved.length) && (
            <section className="flex flex-col gap-2">
              <p className="text-xs text-mute">{saved.length ? savedHead ?? t('watch.savedHead', { n: saved.length }) : savedEmpty}</p>
              {saved.map(s => row(s))}
            </section>
          )}
          {looked.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <p className="flex-1 text-xs text-mute">{t('watch.lookedHead', { n: looked.length })}</p>
                {words && keepable > 0 && <Btn size="sm" onClick={words.onKeepAll}><Plus size={14} /> {t('reader.keepAll', { n: keepable })}</Btn>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {looked.map(w => {
                  const kept = words?.kept(w);
                  const can = words?.can(w);
                  return (
                    <span key={w.word} className="inline-flex h-8 rounded-full bg-shade text-sm overflow-hidden">
                      <button type="button" onClick={e => { e.currentTarget.blur(); onWord(w); }} title={w.line.text}
                        className={`press ${words ? 'pl-3 pr-2' : 'px-3'} hover:bg-line`}>{w.word}</button>
                      {words && (
                        <button type="button" disabled={kept || !can} onClick={e => { e.currentTarget.blur(); words.onKeep(w); }}
                          title={t(kept ? 'definition.kept' : can ? 'definition.keep' : 'reader.keepNoMeaning')} aria-label={`${t('definition.keep')} ${w.word}`}
                          className={`press pl-1.5 pr-2.5 border-l border-line inline-flex items-center ${kept ? 'text-accent' : can ? 'text-mute hover:text-ink hover:bg-line' : 'text-line'}`}>
                          {kept ? <Check size={14} /> : <Plus size={14} />}
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </section>
          )}
        </div>
        <div className="px-6 pt-4 pb-6 flex flex-wrap items-center justify-end gap-2.5">
          {actions}
          {!(pickAll && all.length === 0) && <Btn tone="accent" disabled={chosen.length === 0 || busy} onClick={() => onDrill(chosen)} autoFocus title={chosen.length ? undefined : t('watch.pickHint')}>
            <PenLine size={16} /> {!chosen.length ? t('watch.pickHint') : t(missed.some(m => picked.has(m.line.id)) ? 'listen.drillAdd' : 'watch.drill', { n: chosen.length })}
          </Btn>}
        </div>
      </Card>
    </div>
  );
};

export default WatchSummary;
