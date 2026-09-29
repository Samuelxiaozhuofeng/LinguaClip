import React, { useMemo } from 'react';
import { tokenizeText, TokenType } from '../utils/textTokenizer';
import { useT } from '../utils/i18n';
import { useJaVersion } from '../utils/japanese';
import { getGloss, getLooked, lookedKey, useLookedVersion } from '../utils/readLooked';
import type { WatchSubs } from '../utils/storage';
import { bareWord } from './BlurLine';

// Watch mode's subtitle, laid over the picture. Shown: every word looks up on a
// click. Blurred / hidden: a click shows this one line (the next line covers
// again), then its words look up. Text only — never parsed as HTML. Words looked up
// while reading this video's subtitles (pro/ReaderPage.tsx) are underlined.
const WatchLine: React.FC<{
  videoId: string;
  ja: boolean; // the video is Japanese: words are keyed as the reader keyed them
  text: string;
  subs: WatchSubs;
  revealed: boolean;
  onReveal: () => void;
  onWord: (word: string) => void;
}> = ({ videoId, ja, text, subs, revealed, onReveal, onWord }) => {
  const t = useT();
  const jaVersion = useJaVersion();
  const lookedVersion = useLookedVersion();
  const tokens = useMemo(() => tokenizeText(text), [text, jaVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // token index → the hint shown when pointing at it (with the meaning found while reading)
  const seen = useMemo(() => {
    const looked = new Set(getLooked(videoId));
    const gloss = getGloss(videoId);
    const out = new Map<number, string>();
    for (const tk of tokens) {
      const key = tk.type === TokenType.WORD ? lookedKey(tk.value, ja) : null;
      if (key && looked.has(key)) out.set(tk.index, gloss[key] ? t('watch.lookedBeforeGloss', { word: key, gloss: gloss[key] }) : t('watch.lookedBefore'));
    }
    return out;
  }, [videoId, ja, tokens, lookedVersion, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = 'inline-block max-w-full px-4 py-1.5 rounded-xl bg-black/60 text-white font-serif text-[clamp(20px,2.4vw,34px)] leading-snug';

  if (subs === 'hide' && !revealed) {
    return (
      <button type="button" onClick={e => { e.currentTarget.blur(); onReveal(); }} title={t('watch.showLine')} aria-label={t('watch.showLine')}
        className="press px-4 py-1 rounded-full bg-black/40 text-white/70 text-xl tracking-[0.3em] hover:bg-black/60">···</button>
    );
  }
  if (subs === 'blur' && !revealed) {
    return (
      <button type="button" onClick={e => { e.currentTarget.blur(); onReveal(); }} title={t('watch.showLine')} aria-label={t('watch.showLine')} className={`${box} press`}>
        <span className="block blur-[7px] select-none" aria-hidden>{text}</span>
      </button>
    );
  }
  return (
    <div className={box} data-lookup-line>
      {tokens.map((tk, i) => {
        if (tk.type === TokenType.WORD) {
          const word = bareWord(tk.value);
          return word ? (
            <button key={i} type="button" onClick={e => { e.currentTarget.blur(); onWord(word); }} title={seen.get(tk.index) ?? t('common.lookup')}
              className={`inline rounded px-0.5 hover:bg-white/25 ${seen.has(tk.index) ? 'border-b-2 border-dotted border-accent' : ''}`}>{tk.value}</button>
          ) : <span key={i}>{tk.value}</span>;
        }
        if (tk.type === TokenType.SPACE) return <span key={i}> </span>;
        return <span key={i} className="text-white/80">{tk.value}</span>;
      })}
    </div>
  );
};

export default WatchLine;
