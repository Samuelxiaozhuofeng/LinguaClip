import React, { useMemo } from 'react';
import { Rating, type Grade } from 'ts-fsrs';
import { RotateCcw } from 'lucide-react';
import type { ReviewCard } from '../utils/review';
import type { WordFront } from '../types';
import { sentenceParts } from '../utils/textTokenizer';
import { furigana, hasKanji, readingOf, useJaVersion } from '../utils/japanese';
import { useT } from '../utils/i18n';
import { usePhraseDrag } from '../hooks/usePhraseDrag';

// A word card's two faces (think first, then turn it) and the four FSRS buttons
// every review card ends on.

// A kept meaning is HTML (dictionary text we escaped, but also raw AI text and
// glyph images from dictionary pages), so only <b> <i> <br> <ruby> <rt> <rp> and
// http(s) <img> get through; everything else is flattened to its text.
const clean = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (n: Node): string => [...n.childNodes].map(c => {
    if (c.nodeType === Node.TEXT_NODE) return (c.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!(c instanceof Element)) return '';
    const tag = c.tagName.toLowerCase();
    if (tag === 'br') return '<br/>';
    if (tag === 'script' || tag === 'style') return '';
    if (tag === 'img') { const src = c.getAttribute('src') ?? ''; return /^https?:\/\//.test(src) ? `<img src="${src.replace(/"/g, '&quot;')}">` : ''; }
    return ['b', 'i', 'ruby', 'rt', 'rp'].includes(tag) ? `<${tag}>${walk(c)}</${tag}>` : walk(c);
  }).join('');
  return walk(doc.body);
};

const Html: React.FC<{ html?: string; className?: string }> = ({ html, className }) =>
  html ? <div className={className} dangerouslySetInnerHTML={{ __html: clean(html) }} /> : null;

const MARK = 'text-accent font-semibold underline decoration-2 underline-offset-[10px]';

// The line with the kept word marked. Turned: the word's furigana shows and other
// words' only on hover, and words can be looked up; before that, neither.
const Sentence: React.FC<{ text: string; word: string; turned: boolean; onLookup: (w: string) => void; className: string }> = ({ text, word, turned, onLookup, className }) => {
  const jaVersion = useJaVersion();
  const groups = useMemo(() => sentenceParts(text, word), [text, word, jaVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const { bind, inSel } = usePhraseDrag((a, b) => { if (turned) onLookup(groups.slice(a, b + 1).flatMap(g => g.pieces.map(p => p.s)).join('')); });
  // A phrase is underlined in one go: the spaces and punctuation between its words too.
  const marked = groups.map(g => !!g.word && g.pieces.some(p => p.target));
  const inside = (gi: number) => {
    let a = gi, b = gi;
    while (a > 0 && !groups[a - 1].word) a--;
    while (b < groups.length - 1 && !groups[b + 1].word) b++;
    return a > 0 && b < groups.length - 1 && marked[a - 1] && marked[b + 1];
  };
  return (
    <p className={className}>
      {groups.map((g, gi) => {
        const pieces = g.pieces.map((p, k) => {
          const rt = p.rt && (p.target ? turned && <rt>{p.rt}</rt> : <rt className="opacity-0 group-hover:opacity-100 transition-opacity">{p.rt}</rt>);
          return <span key={k} className={p.target ? MARK : undefined}>{rt ? <ruby>{p.s}{rt}</ruby> : p.s}</span>;
        });
        if (!g.word) return <span key={gi} className={inside(gi) ? MARK : undefined}>{pieces}</span>;
        return turned
          ? <button key={gi} type="button" {...bind(gi)} onClick={e => { e.currentTarget.blur(); onLookup(g.word!); }} className={`group rounded-md hover:bg-accent-soft ${inSel(gi) ? 'bg-accent-soft' : ''}`}>{pieces}</button>
          : <span key={gi} className="group">{pieces}</span>;
      })}
    </p>
  );
};

export const WordFace: React.FC<{ card: ReviewCard; front: WordFront; turned: boolean; onLookup: (w: string) => void; onReplay: () => void }> = ({ card, front, turned, onLookup, onReplay }) => {
  const t = useT();
  const jaVersion = useJaVersion();
  const word = card.word ?? '';
  const head = useMemo(() => hasKanji(word) ? furigana(word, readingOf(word)) : [{ s: word }], [word, jaVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!turned) return (
    <div className="flex flex-col items-center gap-4 fade-in">
      <p className="text-[13px] text-mute">{t(front === 'word' ? 'review.frontWord' : 'review.frontSentence')}</p>
      {front === 'word'
        ? <p className="font-serif text-[64px] font-semibold leading-tight">{word}</p>
        : <Sentence text={card.text} word={word} turned={false} onLookup={onLookup} className="font-serif text-[36px] leading-[2]" />}
    </div>
  );
  return (
    <div className="w-full max-w-3xl flex flex-col gap-4 text-left fade-in">
      <p className="font-serif text-[48px] font-semibold leading-[1.3]">
        {head.map((p, k) => p.rt ? <ruby key={k}>{p.s}<rt>{p.rt}</rt></ruby> : <span key={k}>{p.s}</span>)}
      </p>
      <Html html={card.definition} className="text-[16px] leading-relaxed" />
      {card.ai && <p className="text-[14px] leading-relaxed whitespace-pre-line rounded-xl bg-accent-soft px-4 py-2.5">AI：{card.ai}</p>}
      <div className="px-5 py-3 rounded-2xl bg-shade flex items-center justify-between gap-4">
        <Sentence text={card.text} word={word} turned onLookup={onLookup} className="font-serif text-[24px] leading-[2]" />
        <button type="button" onClick={e => { e.currentTarget.blur(); onReplay(); }} className="press shrink-0 h-9 px-3.5 rounded-full bg-page border border-line text-[13px] flex items-center gap-1.5">
          <RotateCcw size={14} /> {t('review.replay')}
        </button>
      </div>
      <Html html={card.example} className="text-[14px] leading-relaxed text-mute" />
    </div>
  );
};

export const GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
const DAY = 86400000;

// Four buttons, each with when the card comes back. "Again" also comes back later
// this round. `suggest`: the one Enter picks (a sentence card's dictation result).
export const GradeBar: React.FC<{ due: Record<Grade, number> | null; now: number; suggest?: Grade; onGrade: (g: Grade) => void }> = ({ due, now, suggest, onGrade }) => {
  const t = useT();
  const when = (g: Grade) => {
    if (g === Rating.Again) return t('grade.inRound');
    if (!due) return '';
    const d = Math.max(1, Math.round((due[g] - now) / DAY));
    return d === 1 ? t('grade.tomorrow') : d < 30 ? t('grade.days', { n: d }) : d < 365 ? t('grade.months', { n: Math.round(d / 30) }) : t('grade.years', { n: +(d / 365).toFixed(1) });
  };
  return (
    <div className="flex gap-2.5">
      {GRADES.map(g => (
        <button key={g} type="button" onClick={e => { e.currentTarget.blur(); onGrade(g); }}
          className={`press w-[132px] h-[58px] rounded-2xl flex flex-col items-center justify-center gap-0.5 ${g === suggest ? 'border-2 border-accent bg-accent-soft' : 'border border-line bg-page'}`}>
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] text-mute">{g === suggest ? `${g} · ↵` : g}</span>
            <span className={`text-[15px] font-semibold ${g === Rating.Again ? 'text-accent' : 'text-ink'}`}>{t(`grade.${g}` as 'grade.1')}</span>
          </span>
          <span className="text-xs text-mute">{when(g)}</span>
        </button>
      ))}
    </div>
  );
};
