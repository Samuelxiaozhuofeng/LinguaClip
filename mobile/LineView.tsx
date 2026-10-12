// Lines with their text up on the listening page (design Lookup.dc.html): words to tap
// for their meaning (Japanese split into groups once the dictionary is in), "see this
// line" — the line in a card between its neighbours, with listen again / ☆ / 中 — and the
// whole section's transcript for step 2 and free listening.
import React, { useMemo } from 'react';
import type { Subtitle } from '../types';
import { TokenType, tokenizeText } from '../utils/textTokenizer';
import { useJaVersion } from '../utils/japanese';
import { useT } from '../utils/i18n';

export type LineProps = {
  saved: Set<number>; trans: (l: Subtitle) => string | null | undefined; // undefined: closed
  onWord: (w: string, l: Subtitle) => void; onSave: (l: Subtitle) => void; onTrans?: (l: Subtitle) => void;
};

export const Words: React.FC<{ line: Subtitle; onWord: (w: string, l: Subtitle) => void; className?: string }> = ({ line, onWord, className }) => {
  const v = useJaVersion();
  const tokens = useMemo(() => tokenizeText(line.text), [line.text, v]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <p className={className} data-split={tokens.filter(x => x.type === TokenType.WORD).length}>
      {tokens.map(x => x.type === TokenType.WORD
        ? <button key={x.index} onClick={() => onWord(x.value, line)} className="rounded active:bg-accent-soft">{x.value}</button>
        : <span key={x.index}>{x.value}</span>)}
    </p>
  );
};

const TransText: React.FC<{ text: string | null }> = ({ text }) => {
  const t = useT();
  return <p className="text-sm text-mute leading-relaxed">{text ?? t('m.transWait')}</p>;
};

const soft = 'min-h-[44px] px-3.5 rounded-[10px] bg-shade text-sm';

// "See this line": the line before and after faded, the line itself to read and tap.
export const LineCard: React.FC<LineProps & { lines: Subtitle[]; at: number; onAgain: () => void }> = ({ lines, at, saved, trans, onWord, onSave, onTrans, onAgain }) => {
  const t = useT();
  const line = lines[at];
  if (!line) return null;
  const tr = trans(line);
  return (
    <div className="px-5 py-3 flex flex-col gap-3.5">
      {lines[at - 1] && <p className="font-serif text-[17px] leading-normal text-faint">{lines[at - 1].text}</p>}
      <div className="bg-page rounded-2xl shadow-card px-4 py-[18px] flex flex-col gap-3">
        <Words line={line} onWord={onWord} className="font-serif text-[22px] leading-normal" />
        {tr !== undefined && <TransText text={tr} />}
        <div className="flex gap-2 flex-wrap">
          <button className={soft} onClick={onAgain}>{t('m.again')}</button>
          <button className={soft} aria-pressed={saved.has(line.id)} onClick={() => onSave(line)}>{saved.has(line.id) ? t('m.saved') : t('m.save')}</button>
          {onTrans && <button className={soft} aria-pressed={tr !== undefined} onClick={() => onTrans(line)}>{t('reader.transShort')}</button>}
        </div>
      </div>
      {lines[at + 1] && <p className="font-serif text-[17px] leading-normal text-faint">{lines[at + 1].text}</p>}
    </div>
  );
};

// The section's lines; the one being said stands out. ▶ plays from a line.
export const Transcript = React.forwardRef<HTMLDivElement, LineProps & { lines: Subtitle[]; cur: number | null; hint?: string | null; onPlay: (l: Subtitle) => void; onScroll: () => void }>(
  ({ lines, cur, hint, saved, trans, onWord, onSave, onTrans, onPlay, onScroll }, ref) => {
    const t = useT();
    return (
      <div ref={ref} className="h-full overflow-y-auto px-4 pb-6" onTouchMove={onScroll}>
        {hint && <p className="px-1 py-2 text-[13px] text-mute">{hint}</p>}
        {lines.map(l => {
          const tr = trans(l);
          return (
            <div key={l.id} data-line={l.id} className={`flex gap-1 py-2 border-b border-shade ${l.id === cur ? 'bg-accent-soft/60 rounded-xl' : ''}`}>
              <button aria-label={t('listen.playFrom')} className="shrink-0 w-11 h-11 text-mute" onClick={() => onPlay(l)}>▶</button>
              <div className="flex-1 min-w-0 pt-2 flex flex-col gap-1">
                <Words line={l} onWord={onWord} className={`font-serif text-[18px] leading-normal ${l.id === cur ? 'text-ink' : 'text-ink/80'}`} />
                {tr !== undefined && <TransText text={tr} />}
              </div>
              <div className="shrink-0 flex flex-col">
                <button aria-label={t('m.save')} aria-pressed={saved.has(l.id)} className={`w-11 h-11 ${saved.has(l.id) ? 'text-accent' : 'text-mute'}`} onClick={() => onSave(l)}>{saved.has(l.id) ? '★' : '☆'}</button>
                {onTrans && <button aria-label={t('reader.transShow')} className="w-11 h-11 text-[13px] text-mute" onClick={() => onTrans(l)}>{t('reader.transShort')}</button>}
              </div>
            </div>
          );
        })}
      </div>
    );
  },
);
