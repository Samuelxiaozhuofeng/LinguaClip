// What a review card shows on the phone (docs/mobile-web.md 8, docs/android-roadmap.md M2.5):
// a sentence card's dictation (one box, the phone's keyboard; the check marks what differs),
// a word card's two faces (think, then turn, with front/back word pronunciation speaker),
// and the four FSRS buttons plus optional "Got it" (mastered) button on sentence cards.
import React, { useMemo, useState } from 'react';
import { Check, Volume2 } from 'lucide-react';
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

export const WordFace: React.FC<{
  card: ReviewCard;
  front: WordFront;
  turned: boolean;
  onTurn: () => void;
  onReplay: (() => void) | null;
  onSpeakWord?: (() => void) | null;
  speaking?: boolean;
}> = ({ card, front, turned, onTurn, onReplay, onSpeakWord, speaking }) => {
  const t = useT();
  const word = card.word ?? '';
  const speakerBtn = onSpeakWord ? (
    <button
      type="button"
      onClick={onSpeakWord}
      aria-label={t('review.playWord')}
      title={t('review.playWord')}
      className={`shrink-0 min-w-[44px] min-h-[44px] px-3 rounded-full flex items-center justify-center gap-1.5 text-[13px] ${speaking ? 'bg-accent-soft text-accent' : 'bg-shade text-ink active:bg-line'}`}
    >
      <Volume2 size={18} />
      <span className="sr-only">{t('review.playWord')}</span>
    </button>
  ) : null;

  if (!turned) return (
    <div className="flex flex-col items-center gap-5 text-center pt-4">
      <p className="text-[13px] text-mute">{t(front === 'word' ? 'review.frontWord' : 'review.frontSentence')}</p>
      <div className="flex items-center justify-center gap-2.5 max-w-full">
        {front === 'word' ? <p className="font-serif text-[44px] font-semibold leading-tight break-all">{word}</p>
          : <Marked text={card.text} word={word} className="font-serif text-[24px] leading-relaxed" />}
        {speakerBtn}
      </div>
      <button type="button" className={`${btnPrimary} w-full mt-3`} onClick={onTurn}>{t('review.show')}</button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5">
        <p className="flex-1 min-w-0 font-serif text-[34px] font-semibold leading-tight break-all">{word}</p>
        {speakerBtn}
      </div>
      <Html html={card.definition} className="text-[16px] leading-relaxed" />
      {card.ai && <p className="text-sm leading-relaxed whitespace-pre-line rounded-xl bg-accent-soft px-3.5 py-2.5">AI：{card.ai}</p>}
      <div className="px-4 py-3 rounded-2xl bg-shade flex items-center gap-3">
        <Marked text={card.text} word={word} className="flex-1 font-serif text-[18px] leading-relaxed" />
        {onReplay && <button type="button" onClick={onReplay} className="shrink-0 min-h-[44px] px-3.5 rounded-full bg-page text-[13px] shadow-card">{t('review.replay')}</button>}
      </div>
      <Html html={card.example} className="text-sm leading-relaxed text-mute" />
    </div>
  );
};

export const GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
const DAY = 86400000;

export const GradeBar: React.FC<{
  due: Record<Grade, number> | null;
  now: number;
  suggest?: Grade;
  onGrade: (g: Grade) => void;
  canMaster?: boolean;
  onMaster?: () => void;
}> = ({ due, now, suggest, onGrade, canMaster, onMaster }) => {
  const t = useT();
  const when = (g: Grade) => {
    if (g === Rating.Again) return t('grade.inRound');
    if (!due) return '';
    const d = Math.max(1, Math.round((due[g] - now) / DAY));
    return d === 1 ? t('grade.tomorrow') : d < 30 ? t('grade.days', { n: d }) : d < 365 ? t('grade.months', { n: Math.round(d / 30) }) : t('grade.years', { n: +(d / 365).toFixed(1) });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-4 gap-2">
        {GRADES.map(g => (
          <button key={g} type="button" onClick={() => onGrade(g)} data-suggest={g === suggest || undefined}
            className={`h-16 rounded-[14px] flex flex-col items-center justify-center gap-0.5 ${g === suggest ? 'bg-accent text-white' : 'bg-page shadow-card'}`}>
            <span className={`text-[15px] font-semibold ${g === Rating.Again && g !== suggest ? 'text-accent' : ''}`}>{t(`grade.${g}` as DictKey)}</span>
            <span className={`text-[11px] ${g === suggest ? '' : 'text-mute'}`}>{when(g)}</span>
          </button>
        ))}
      </div>
      {canMaster && onMaster && (
        <button
          type="button"
          onClick={onMaster}
          title={t('review.masteredTitle')}
          className="min-h-[44px] w-full rounded-[12px] bg-page border border-line text-ink text-[14px] font-medium flex items-center justify-center gap-1.5 active:bg-shade"
        >
          <Check size={16} className="text-mute" />
          <span>{t('review.mastered')}</span>
        </button>
      )}
    </div>
  );
};
