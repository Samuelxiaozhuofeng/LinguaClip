import React, { useState } from 'react';
import { ArrowLeft, Play, RotateCcw, PenLine } from 'lucide-react';
import { Subtitle } from '../types';
import { Btn, Card } from './ui';
import { useT } from '../utils/i18n';
import { formatTimeCode } from '../utils/storage';

export type Looked = { word: string; line: Subtitle };

// What this watch left behind: the video's saved lines (tick a few to dictate
// them now) and the words looked up this time. Esc / a click outside only
// closes it — never counts as leaving or dictating.
const WatchSummary: React.FC<{
  saved: Subtitle[];
  looked: Looked[];
  ended: boolean;
  onClose: () => void;
  onResume: () => void;
  onRestart: () => void;
  onExit: () => void;
  onJump: (line: Subtitle) => void;
  onWord: (w: Looked) => void;
  onDrill: (lines: Subtitle[]) => void;
}> = ({ saved, looked, ended, onClose, onResume, onRestart, onExit, onJump, onWord, onDrill }) => {
  const t = useT();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = saved.filter(s => picked.has(s.id));

  return (
    <div className="fixed inset-0 z-30 bg-black/50 flex items-center justify-center p-4 fade-in" onClick={onClose}>
      <Card className="w-full max-w-xl max-h-[85vh] flex flex-col shadow-lift" role="dialog" aria-modal="true" aria-label={t('watch.summaryTitle')} onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-2">
          <h3 className="text-xl font-semibold leading-tight">{ended ? t('watch.summaryEnded') : t('watch.summaryTitle')}</h3>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-2 flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <p className="text-xs text-mute">{saved.length ? t('watch.savedHead', { n: saved.length }) : t('watch.savedEmpty')}</p>
            {saved.map(s => (
              <div key={s.id} className="flex items-start gap-3">
                <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} aria-label={t('watch.pickLine')} className="mt-1.5 w-4 h-4 accent-accent shrink-0" />
                <button type="button" onClick={() => onJump(s)} title={t('watch.jumpTo')} className="min-w-0 flex-1 text-left rounded-lg px-2 py-1 -my-1 hover:bg-shade">
                  <span className="font-serif text-[17px] leading-snug">{s.text}</span>
                  <span className="ml-2 text-xs text-mute tabular-nums">{formatTimeCode(s.startTime)}</span>
                </button>
              </div>
            ))}
          </section>
          {looked.length > 0 && (
            <section className="flex flex-col gap-2">
              <p className="text-xs text-mute">{t('watch.lookedHead', { n: looked.length })}</p>
              <div className="flex flex-wrap gap-1.5">
                {looked.map(w => (
                  <button key={w.word} type="button" onClick={e => { e.currentTarget.blur(); onWord(w); }} title={w.line.text}
                    className="press h-8 px-3 rounded-full bg-shade text-sm hover:bg-line">{w.word}</button>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="px-6 pt-4 pb-6 flex flex-wrap items-center justify-end gap-2.5">
          <Btn onClick={onExit}><ArrowLeft size={16} /> {t('studio.backToVideosBtn')}</Btn>
          {ended
            ? <Btn onClick={onRestart}><RotateCcw size={16} /> {t('watch.restart')}</Btn>
            : <Btn onClick={onResume}><Play size={16} /> {t('watch.keepWatching')}</Btn>}
          <Btn tone="accent" disabled={chosen.length === 0} onClick={() => onDrill(chosen)} autoFocus title={chosen.length ? undefined : t('watch.pickHint')}>
            <PenLine size={16} /> {chosen.length ? t('watch.drill', { n: chosen.length }) : t('watch.pickHint')}
          </Btn>
        </div>
      </Card>
    </div>
  );
};

export default WatchSummary;
