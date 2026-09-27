import React, { useState, useEffect, useRef, useMemo } from 'react';
import { PracticeMode } from '../types';
import {
  tokenizeText, getWordTokens, Token, TokenType, compareWords,
  isInputCorrectFlexibleCase, areAllWordsCorrectFlexibleCase,
} from '../utils/textTokenizer';
import { ArrowRight } from 'lucide-react';
import { Btn } from './ui';
import { useT } from '../utils/i18n';
import { matches } from '../utils/shortcuts';
import { useJaVersion } from '../utils/japanese';
import { wordSpans } from '../utils/wordTimes';
import type { Word } from '../utils/resegment';

// Dictation line: one input box per word (INPUT), then a word-by-word comparison (FEEDBACK).
// Word lookup is delegated to Studio via onLookup.
interface Props {
  targetText: string;
  mode: PracticeMode;
  onComplete: (wasCorrect: boolean) => void;
  // fromRatio / toRatio: 0..1 into the line; toRatio set = stop there (one word).
  onReplay: (autoAdvanceAfter?: boolean, fromRatio?: number, toRatio?: number) => void;
  onLookup: (word: string) => void;
  blanks?: number[]; // word indices the user types; omit = every word
  nextLabel?: string; // feedback's forward button; defaults to "next line"
  hideNext?: boolean; // no forward button: the caller moves on (review's grade buttons)
  // Once per attempt, when the line is done (all right, or submitted): did it
  // come out right, and was help used (peek, or playing from a word).
  onResult?: (o: { correct: boolean; helped: boolean }) => void;
  extra?: React.ReactNode; // shown beside the feedback's forward button
  // Japanese: when the line may re-split (the practice page decides, so its blanks
  // and these boxes always count the same split). Omitted: re-split until typed in.
  splitVersion?: number;
  timedWords?: Word[]; // the line's spoken words, times as 0..1 of the line (wordsInLine)
}

// How far into the line word i starts, by letters: a rough stand-in for time when
// there are no word timings.
const letterRatio = (words: string[], i: number): number => {
  const len = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, '').length || 1;
  const total = words.reduce((n, w) => n + len(w), 0);
  const before = words.slice(0, i).reduce((n, w) => n + len(w), 0);
  return total ? before / total : 0;
};

// Width of an empty slot for a word: Latin letters are narrow, kana and kanji about 1em.
export const slotEm = (word: string) =>
  Math.max(0.92, [...word].reduce((n, ch) => n + (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.46), 0));

// Typing and the answer share one setting, so submitting changes colours, not positions.
export const LINE = 'flex flex-wrap justify-center items-baseline gap-x-[0.3em] font-serif text-[38px] leading-[54px]';

const DictationLine: React.FC<Props> = ({ targetText, mode, onComplete, onReplay, onLookup, blanks, nextLabel, hideNext, onResult, extra, splitVersion, timedWords }) => {
  const t = useT();
  // A Japanese line is re-split when its dictionary or AI cut points arrive, but
  // never under the user's fingers: once something is typed the split holds.
  const jaVersion = useJaVersion();
  const [ownVersion, setOwnVersion] = useState(jaVersion);
  const typedRef = useRef(false);
  useEffect(() => { if (!typedRef.current) setOwnVersion(jaVersion); }, [jaVersion, targetText]);
  const version = splitVersion ?? ownVersion;
  const tokens = useMemo(() => tokenizeText(targetText), [targetText, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const wordTokens = useMemo(() => getWordTokens(tokens), [tokens]);
  // Each box's time in the line; without word timings, a guess by letters.
  const spans = useMemo(() => wordSpans(wordTokens.map(w => w.value), timedWords), [wordTokens, timedWords]);
  const spanOf = (i: number): [number, number] => {
    const values = wordTokens.map(w => w.value);
    return spans?.[i] ?? [letterRatio(values, i), letterRatio(values, i + 1)];
  };
  // Each word carries the punctuation right after it, so a comma sits on its word, not a gap away.
  const groups = useMemo(() => {
    const out: { key: number; wi: number; word?: Token; punct: string }[] = [];
    let wi = 0;
    tokens.forEach((tk, ti) => {
      if (tk.type === TokenType.WORD) out.push({ key: ti, wi: wi++, word: tk, punct: '' });
      else if (tk.type === TokenType.PUNCTUATION) {
        if (out.length) out[out.length - 1].punct += tk.value;
        else out.push({ key: ti, wi: -1, punct: tk.value });
      }
    });
    return out;
  }, [tokens]);
  const blankSet = useMemo(() => blanks ? new Set(blanks) : null, [blanks]);
  const isBlank = (i: number) => blankSet === null || blankSet.has(i);
  const stepBlank = (from: number, dir: number) => {
    for (let i = from + dir; i >= 0 && i < wordTokens.length; i += dir) {
      if (isBlank(i)) return i;
    }
    return -1;
  };
  const firstBlank = () => {
    for (let i = 0; i < wordTokens.length; i++) if (isBlank(i)) return i;
    return 0;
  };

  const [inputs, setInputs] = useState<string[]>([]);
  typedRef.current = mode === PracticeMode.INPUT && inputs.some((w, i) => isBlank(i) && !!w);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [peek, setPeek] = useState<number | null>(null);
  const peekTimer = useRef<number | null>(null);
  const replayTimer = useRef<number | null>(null);
  const attempt = useRef({ helped: false, reported: false });
  const report = (correct: boolean) => {
    if (attempt.current.reported) return;
    attempt.current.reported = true;
    onResult?.({ correct, helped: attempt.current.helped });
  };

  useEffect(() => {
    if (mode === PracticeMode.INPUT) {
      attempt.current = { helped: false, reported: false };
      setInputs(wordTokens.map((w, i) => isBlank(i) ? '' : w.value));
      refs.current = refs.current.slice(0, wordTokens.length);
      setTimeout(() => refs.current[firstBlank()]?.focus(), 50);
    }
  }, [mode, targetText, wordTokens, blankSet]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearPeek = () => {
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
    peekTimer.current = null;
    setPeek(null);
  };
  const clearReplay = () => { if (replayTimer.current) window.clearTimeout(replayTimer.current); replayTimer.current = null; };
  useEffect(() => { clearPeek(); clearReplay(); }, [targetText, mode]);
  useEffect(() => () => { clearPeek(); clearReplay(); }, []);

  const showPeek = (i: number) => {
    if (!wordTokens[i]) return;
    attempt.current.helped = true;
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
    setPeek(i);
    peekTimer.current = window.setTimeout(() => { setPeek(null); peekTimer.current = null; }, 2000);
  };

  // composing: a Japanese (or Chinese) input method is still turning keystrokes
  // into text; the word is only judged once it is committed.
  const change = (i: number, value: string, composing = false) => {
    const next = [...inputs];
    next[i] = value;
    setInputs(next);
    if (composing) return;
    settle(i, next);
  };

  const settle = (i: number, next: string[]) => {
    if (!isInputCorrectFlexibleCase(next[i] ?? '', wordTokens[i].value, wordTokens[i].reading)) return;
    const nxt = stepBlank(i, 1);
    if (nxt >= 0) {
      setTimeout(() => refs.current[nxt]?.focus(), 100);
    } else if (areAllWordsCorrectFlexibleCase(tokens, next)) {
      report(true);
      clearReplay();
      // All right: replay once and show the answer, then wait for Enter so words can be looked up.
      replayTimer.current = window.setTimeout(() => { onReplay(false); onComplete(true); }, 200);
    }
  };

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (mode !== PracticeMode.INPUT) return;
    clearReplay();
    if (!inputs.some(w => w.trim().length > 0)) return;
    const correct = areAllWordsCorrectFlexibleCase(tokens, inputs);
    report(correct);
    onComplete(correct);
  };

  const keyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    // Space picks a kanji and Enter commits it inside an input method; those keys
    // are not ours. Safari reports the committing Enter with keyCode 229.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (matches(e, 'reveal')) { e.preventDefault(); e.stopPropagation(); report(false); onComplete(false); return; }
    if (matches(e, 'replay')) { e.preventDefault(); e.stopPropagation(); clearReplay(); onReplay(false); return; }
    if (matches(e, 'playFrom')) { e.preventDefault(); e.stopPropagation(); clearReplay(); attempt.current.helped = true; onReplay(false, spanOf(i)[0]); return; }
    if (matches(e, 'playWord')) { e.preventDefault(); e.stopPropagation(); clearReplay(); attempt.current.helped = true; onReplay(false, ...spanOf(i)); return; }
    if (matches(e, 'peek')) { e.preventDefault(); showPeek(i); return; }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const nxt = stepBlank(i, 1);
      if (nxt >= 0) refs.current[nxt]?.focus(); else submit();
    } else if (e.key === 'Backspace' && inputs[i] === '') {
      const prev = stepBlank(i, -1);
      if (prev >= 0) { e.preventDefault(); refs.current[prev]?.focus(); }
    } else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0) {
      const prev = stepBlank(i, -1);
      if (prev >= 0) { e.preventDefault(); refs.current[prev]?.focus(); }
    } else if (e.key === 'ArrowRight' && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      const nxt = stepBlank(i, 1);
      if (nxt >= 0) { e.preventDefault(); refs.current[nxt]?.focus(); }
    }
  };

  const paste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const words = e.clipboardData.getData('text').trim().split(/\s+/);
    const next = [...inputs];
    const slots = wordTokens.map((_, i) => i).filter(i => isBlank(i));
    const limit = Math.min(words.length, slots.length);
    for (let k = 0; k < limit; k++) next[slots[k]] = words[k];
    setInputs(next);
    refs.current[slots[Math.min(limit, slots.length - 1)] ?? firstBlank()]?.focus();
  };

  const lookup = (raw: string) => {
    const w = raw.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]/g, '');
    if (w) onLookup(w);
  };

  // The word to look up at group gi: a hyphenated word (well-being) or a word with two
  // curly apostrophes (rock’n’roll) splits into several words here; clicking any part looks up the
  // whole, as before. Only parts with nothing between them join (a closing ’ before a
  // space does not).
  const joins = (g?: typeof groups[number], h?: typeof groups[number]) =>
    !!g?.word && !!h?.word && (g.punct === '-' || g.punct === '\u2019') && h.word.index === g.word.index + 2;
  const wordAt = (gi: number) => {
    let from = gi, to = gi;
    while (joins(groups[from - 1], groups[from])) from--;
    while (joins(groups[to], groups[to + 1])) to++;
    return groups.slice(from, to + 1).map((g, k, all) => g.word!.value + (k < all.length - 1 ? g.punct : '')).join('');
  };

  if (mode === PracticeMode.FEEDBACK) {
    const results = compareWords(tokens, inputs);
    const wrong = new Map(results.filter(r => !r.isCorrect).map(r => [r.tokenIndex, r]));
    const typed = wordTokens.filter((_, i) => isBlank(i)).length;
    return (
      <div className="w-full flex flex-col items-center gap-5">
        {/* The answer, in the same place and size as the boxes were. A wrong word turns
            accent with what you typed struck out above it; a word left blank is only
            underlined (seeing the answer is not an error); click any word to look it up. */}
        <p className={`${LINE} gap-y-5 pt-4`} data-lookup-line>
          {groups.map((g, gi) => {
            if (!g.word) return <span key={g.key} className="text-mute">{g.punct}</span>;
            const r = isBlank(g.wi) ? wrong.get(g.word.index) : undefined;
            return (
              <span key={g.key} className="relative inline-flex items-baseline">
                {r?.inputWord && (
                  <span className="absolute -top-4 left-1/2 -translate-x-1/2 font-sans text-sm leading-none text-mute line-through whitespace-nowrap" title={t('dictation.youTyped')}>
                    {r.inputWord}
                  </span>
                )}
                <button type="button" onClick={e => { e.currentTarget.blur(); lookup(wordAt(gi)); }} title={r ? t('dictation.expected', { word: r.targetWord }) : t('common.lookup')}
                  className={`rounded-md -mx-1 px-1 hover:bg-accent-soft ${!r ? '' : r.inputWord ? 'text-accent underline decoration-2 underline-offset-[8px]' : 'underline decoration-faint decoration-2 underline-offset-[8px]'}`}>
                  {g.word.value}
                </button>
                <span className="text-mute">{g.punct}</span>
              </span>
            );
          })}
        </p>

        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
          <span className="text-[13px] text-mute">{inputs.some((w, i) => isBlank(i) && w.trim()) ? t('dictation.score', { right: typed - wrong.size, total: typed }) : t('dictation.revealed')}</span>
          {!hideNext && (
            <div className="flex gap-2.5">
              <Btn tone="accent" onClick={() => onComplete(true)}>{nextLabel ?? t('common.nextLine')} <ArrowRight size={15} /></Btn>
              {extra}
            </div>
          )}
        </div>
      </div>
    );
  }

  // INPUT mode
  return (
    <div className="w-full">
      <form onSubmit={submit} className={`${LINE} pt-4`}>
        {groups.map(g => {
          const punct = g.punct && <span className="text-mute select-none">{g.punct}</span>;
          if (g.wi < 0) return <span key={g.key}>{punct}</span>;
          const i = g.wi;
          const tk = g.word!;
          if (!isBlank(i)) {
            return <span key={g.key} className="text-ink/40 select-none">{tk.value}{punct}</span>;
          }
          const ok = !!inputs[i] && isInputCorrectFlexibleCase(inputs[i], tk.value, tk.reading);
          return (
            <span key={g.key} className="relative inline-flex items-baseline">
              {/* The slot grows with what you type; once the word is right it shrinks to fit, so the line reads like prose. */}
              <span className="inline-grid" style={{ minWidth: ok ? 0 : `${slotEm(tk.value) + 0.3}em` }}>
                <input
                  ref={el => { refs.current[i] = el; }}
                  type="text"
                  size={1}
                  value={inputs[i] || ''}
                  onChange={e => change(i, e.target.value, (e.nativeEvent as InputEvent).isComposing)}
                  onCompositionEnd={e => settle(i, Object.assign([...inputs], { [i]: e.currentTarget.value }))}
                  onKeyDown={e => keyDown(i, e)}
                  onPaste={paste}
                  // A 44px box keeps the underline just under the letters (not under the descenders), so a comma or full stop sits on it.
                  className={`col-start-1 row-start-1 w-full min-w-0 h-[44px] p-0 bg-transparent border-0 border-b-2 rounded-none font-serif text-ink caret-accent outline-none focus:outline-none focus-visible:outline-none ${ok ? 'border-transparent' : 'border-faint focus:border-accent'}`}
                  autoComplete="off" autoCorrect="off" spellCheck={false}
                />
                <span className="invisible h-0 overflow-hidden whitespace-pre col-start-1 row-start-1">{inputs[i] || ''}</span>
              </span>
              {punct}
              {peek === i && (
                <span className="absolute -top-12 left-1/2 -translate-x-1/2 rounded-md bg-ink text-white px-3 py-1 font-serif text-xl leading-7 whitespace-nowrap pointer-events-none z-10 fade-in">
                  {tk.value}
                </span>
              )}
            </span>
          );
        })}
      </form>
    </div>
  );
};

export default DictationLine;
