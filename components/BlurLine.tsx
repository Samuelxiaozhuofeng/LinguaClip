import React, { useEffect, useMemo, useState } from 'react';
import { tokenizeText, TokenType } from '../utils/textTokenizer';
import { useT } from '../utils/i18n';
import { useJaVersion } from '../utils/japanese';
import { usePhraseDrag } from '../hooks/usePhraseDrag';

// A clicked word without its punctuation: what gets looked up.
export const bareWord = (raw: string) => raw.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]/g, '');

// Blur mode line: every word starts as a covered block. First click reveals it,
// second click looks it up; dragging across words opens them all and looks the phrase up.
// Lookup itself lives in Studio (DefinitionPanel).
// onReveal fires once per line, on the first covered word opened.
const BlurLine: React.FC<{ text: string; onLookup: (word: string) => void; onReveal?: () => void }> = ({ text, onLookup, onReveal }) => {
  const t = useT();
  const jaVersion = useJaVersion();
  const tokens = useMemo(() => tokenizeText(text), [text, jaVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => { setRevealed(new Set()); setPicked(null); }, [text, jaVersion]);

  const wordTok = useMemo(() => tokens.filter(tk => tk.type === TokenType.WORD).map(tk => tk.index), [tokens]);
  const { bind, inSel } = usePhraseDrag((a, b) => {
    if (revealed.size === 0) onReveal?.();
    setRevealed(prev => { const n = new Set(prev); for (let k = a; k <= b; k++) n.add(k); return n; });
    setPicked(null);
    onLookup(tokens.slice(wordTok[a], wordTok[b] + 1).map(tk => tk.value).join(''));
  });

  const click = (e: React.MouseEvent<HTMLButtonElement>, wordIdx: number, raw: string) => {
    e.currentTarget.blur(); // keep Space/Enter shortcuts from re-firing this button
    const word = bareWord(raw);
    if (!word) return;
    if (!revealed.has(wordIdx)) {
      if (revealed.size === 0) onReveal?.();
      setRevealed(prev => new Set(prev).add(wordIdx));
      setPicked(wordIdx);
      return;
    }
    setPicked(wordIdx);
    onLookup(word);
  };

  let wordIdx = 0;
  return (
    <div className="font-serif text-[36px] leading-[1.5] text-center" data-lookup-line>
      {tokens.map((tk, i) => {
        if (tk.type === TokenType.WORD) {
          const idx = wordIdx++;
          const isRevealed = revealed.has(idx);
          const isPicked = picked === idx;
          return (
            <button
              key={i}
              type="button"
              {...bind(idx)}
              onClick={e => click(e, idx, tk.value)}
              title={isRevealed ? t('common.lookup') : t('blur.reveal')}
              aria-label={isRevealed ? undefined : t('blur.hiddenWord')}
              className={`press inline-block align-baseline rounded-md px-1 ${
                isRevealed || inSel(idx)
                  ? (isPicked || inSel(idx) ? 'mark-yellow' : 'hover:mark-yellow')
                  : 'bg-shade text-transparent select-none hover:bg-line'}`}
            >
              {tk.value}
            </button>
          );
        }
        if (tk.type === TokenType.PUNCTUATION) {
          return <span key={i} className="text-mute">{tk.value}</span>;
        }
        if (tk.type === TokenType.SPACE) return <span key={i}> </span>;
        return null;
      })}
    </div>
  );
};

export default BlurLine;
