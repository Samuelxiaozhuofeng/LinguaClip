// What a review card shows on the phone (design Review.dc.html): a sentence card's
// dictation (one box, the phone's keyboard; the check marks what differs), a word card's
// two faces (think, then turn), and the four FSRS buttons with when each brings the card back.
import React, { useMemo, useState } from 'react';
import { Rating, type Grade } from 'ts-fsrs';
import type { ReviewCard } from '../utils/review';
import type { WordFront } from '../types';
import { sentenceParts } from '../utils/textTokenizer';
import { useJaVersion } from '../utils/japanese';
import { clean } from '../utils/cleanHtml';
import { useT, type DictKey } from '../utils/i18n';
import { checkDictation, type Checked } from './dictation';
import { btnPrimary } from './ui';

export const Html: React.FC<{ html?: string; className?: string }> = ({ html, className }) =>
  html ? <div className={className} dangerouslySetInnerHTML={{ __html: clean(html) }} /> : null;

export const Dictation: React.FC<{ card: ReviewCard; trans: string | null; onChecked: (c: Checked) => void }> = ({ card, trans, onChecked }) => {
  const t = useT();
  const [typed, setTyped] = useState('');
  const [res, setRes] = useState<Checked | null>(null);
  const submit = () => { if (res) return; const c = checkDictation(card.text, typed); setRes(c); onChecked(c); };
  if (!res) return (
    <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); submit(); }}>
      <textarea value={typed} onChange={e => setTyped(e.target.value)} rows={3} enterKeyHint="done" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
        aria-label={t('m.typeHere')} placeholder={t('m.typeHere')} className="w-full rounded-xl bg-shade px-3.5 py-3 font-serif text-[18px] leading-normal outline-none focus:ring-2 focus:ring-accent/30" />
      <button type="submit" className={btnPrimary}>{t('m.check')}</button>
    </form>
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-mute">{t('m.youTyped')}</p>
      <p className="font-serif text-[20px] leading-relaxed" data-wrong={res.wrong}>
        {res.pieces.map((p, i) => (
          <span key={i} className={p.kind === 'extra' ? 'text-accent line-through' : p.kind === 'miss' ? 'font-semibold underline decoration-2 underline-offset-4' : undefined}>{p.s}</span>
        ))}
      </p>
      {trans && <><div className="h-px bg-shade" /><p className="text-sm text-mute">{trans}</p></>}
    </div>
  );
};

// The line with the kept word marked.
const Marked: React.FC<{ text: string; word: string; className: string }> = ({ text, word, className }) => {
  const v = useJaVersion();
  const groups = useMemo(() => sentenceParts(text, word), [text, word, v]); // eslint-disable-line react-hooks/exhaustive-deps
  return <p className={className}>{groups.flatMap(g => g.pieces).map((p, k) => <span key={k} className={p.target ? 'text-accent font-semibold' : undefined}>{p.s}</span>)}</p>;
};

export const WordFace: React.FC<{ card: ReviewCard; front: WordFront; turned: boolean; onTurn: () => void; onReplay: (() => void) | null }> = ({ card, front, turned, onTurn, onReplay }) => {
  const t = useT();
  const word = card.word ?? '';
  if (!turned) return (
    <div className="flex flex-col items-center gap-5 text-center pt-6">
      <p className="text-[13px] text-mute">{t(front === 'word' ? 'review.frontWord' : 'review.frontSentence')}</p>
      {front === 'word' ? <p className="font-serif text-[44px] font-semibold leading-tight break-all">{word}</p>
        : <Marked text={card.text} word={word} className="font-serif text-[24px] leading-relaxed" />}
      <button className={`${btnPrimary} w-full mt-4`} onClick={onTurn}>{t('review.show')}</button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3.5">
      <p className="font-serif text-[34px] font-semibold leading-tight break-all">{word}</p>
      <Html html={card.definition} className="text-[16px] leading-relaxed" />
      {card.ai && <p className="text-sm leading-relaxed whitespace-pre-line rounded-xl bg-accent-soft px-3.5 py-2.5">AI：{card.ai}</p>}
      <div className="px-4 py-3 rounded-2xl bg-shade flex items-center gap-3">
        <Marked text={card.text} word={word} className="flex-1 font-serif text-[18px] leading-relaxed" />
        {onReplay && <button onClick={onReplay} className="shrink-0 min-h-[44px] px-3 rounded-full bg-page text-[13px]">{t('review.replay')}</button>}
      </div>
      <Html html={card.example} className="text-sm leading-relaxed text-mute" />
    </div>
  );
};

export const GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
const DAY = 86400000;

export const GradeBar: React.FC<{ due: Record<Grade, number> | null; now: number; suggest?: Grade; onGrade: (g: Grade) => void }> = ({ due, now, suggest, onGrade }) => {
  const t = useT();
  const when = (g: Grade) => {
    if (!due) return '';
    const d = Math.max(1, Math.round((due[g] - now) / DAY));
    return d === 1 ? t('grade.tomorrow') : d < 30 ? t('grade.days', { n: d }) : d < 365 ? t('grade.months', { n: Math.round(d / 30) }) : t('grade.years', { n: +(d / 365).toFixed(1) });
  };
  return (
    <div className="grid grid-cols-4 gap-2">
      {GRADES.map(g => (
        <button key={g} onClick={() => onGrade(g)} data-suggest={g === suggest || undefined}
          className={`h-16 rounded-[14px] flex flex-col items-center justify-center gap-0.5 ${g === suggest ? 'bg-accent text-white' : 'bg-page shadow-card'}`}>
          <span className="text-[15px] font-semibold">{t(`grade.${g}` as DictKey)}</span>
          <span className={`text-[11px] ${g === suggest ? '' : 'text-mute'}`}>{when(g)}</span>
        </button>
      ))}
    </div>
  );
};
