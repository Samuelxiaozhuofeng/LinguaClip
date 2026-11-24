// Word-by-word sentence view shared by Dictation and Custom ways:
// - Pre-submit: underlined blank slots (only hinted words revealed), no spoilers.
// - Graded: right in ink, wrong in accent + accent underline, near miss in dashed
//   accent underline with only differing letters highlighted in accent.
// - Revealed: full sentence, every word tappable for WordSheet lookup.
// Each word is grouped with its trailing punctuation so commas/periods never orphan on a new line.
import React, { useMemo } from 'react';
import {
  TokenType,
  getWordTokens,
  letters,
  type Token,
} from '../../utils/textTokenizer';
import type { Checked } from '../dictation';
import { slotWidthEm, stripLookupPunct } from './drillCommon';

export interface GradedLineProps {
  tokens: Token[];
  hinted: ReadonlySet<number>;
  result: Checked | null;
  revealed: boolean;
  onWord?: (word: string) => void;
  compact?: boolean;
}

type WordGroup = { key: number; wi: number; word?: Token; punct: string };

function groupTokens(tokens: Token[]): WordGroup[] {
  const out: WordGroup[] = [];
  let wi = 0;
  for (const tk of tokens) {
    if (tk.type === TokenType.WORD) {
      out.push({ key: tk.index, wi: wi++, word: tk, punct: '' });
    } else if (tk.type === TokenType.PUNCTUATION) {
      if (out.length > 0 && out[out.length - 1].word) {
        out[out.length - 1].punct += tk.value;
      } else {
        out.push({ key: tk.index, wi: -1, punct: tk.value });
      }
    }
  }
  return out;
}

export const GradedLine: React.FC<GradedLineProps> = ({
  tokens,
  hinted,
  result,
  revealed,
  onWord,
  compact = false,
}) => {
  const wordTokens = useMemo(() => getWordTokens(tokens), [tokens]);
  const groups = useMemo(() => groupTokens(tokens), [tokens]);
  const textSize = compact ? 'text-[19px] leading-[1.75]' : 'text-[23px] leading-[1.8]';
  const tapWord = (raw: string) => {
    const clean = stripLookupPunct(raw);
    if (clean && onWord) onWord(clean);
  };

  return (
    <p className={`font-serif ${textSize} flex flex-wrap items-baseline gap-x-[0.35em] gap-y-2`} data-testid="dict-sentence">
      {groups.map(g => {
        const punct = g.punct ? <span className="text-mute">{g.punct}</span> : null;
        if (!g.word) {
          return <span key={g.key}>{punct}</span>;
        }
        const tk = g.word;
        const wordIdx = g.wi;

        // Pre-submit, not revealed: blank underline slot unless hinted.
        if (!result && !revealed) {
          if (hinted.has(wordIdx)) {
            return (
              <span key={g.key} className="inline-flex items-baseline">
                <span data-hint-word={wordIdx} className="text-ink/80 border-b-2 border-faint px-0.5">
                  {tk.value}
                </span>
                {punct}
              </span>
            );
          }
          return (
            <span key={g.key} className="inline-flex items-baseline">
              <span
                data-blank={wordIdx}
                aria-hidden
                className="inline-block border-b-2 border-faint align-baseline"
                style={{ width: `${slotWidthEm(tk.value)}em`, height: '1.15em' }}
              />
              {punct}
            </span>
          );
        }

        // Revealed without grading: clean readable text, tappable to look up.
        if (revealed && !result) {
          return (
            <span key={g.key} className="inline-flex items-baseline">
              <button
                type="button"
                onClick={() => tapWord(tk.value)}
                className="text-ink rounded px-0.5 active:bg-accent-soft"
              >
                {tk.value}
              </button>
              {punct}
            </span>
          );
        }

        // Graded result: per-word verdict (or single-line fallback for Japanese).
        const perWord = result!.words.length === wordTokens.length
          ? result!.words[wordIdx]
          : result!.words[0];
        const verdict = perWord?.verdict ?? 'wrong';
        const marks = verdict === 'near' ? perWord?.marks : null;

        if (verdict === 'right') {
          return (
            <span key={g.key} className="inline-flex items-baseline">
              <button
                type="button"
                data-verdict="right"
                onClick={() => tapWord(tk.value)}
                className="text-ink rounded px-0.5 active:bg-accent-soft"
              >
                {tk.value}
              </button>
              {punct}
            </span>
          );
        }

        if (verdict === 'near') {
          const chars = letters(tk.value);
          return (
            <span key={g.key} className="inline-flex items-baseline">
              <button
                type="button"
                data-verdict="near"
                onClick={() => tapWord(tk.value)}
                className="text-ink rounded px-0.5 underline decoration-dashed decoration-accent decoration-2 underline-offset-[6px] active:bg-accent-soft"
              >
                {marks && marks.length === chars.length
                  ? chars.map((ch, k) => (
                      marks[k]
                        ? <span key={k} data-near-diff className="text-accent">{ch}</span>
                        : <React.Fragment key={k}>{ch}</React.Fragment>
                    ))
                  : tk.value}
              </button>
              {punct}
            </span>
          );
        }

        return (
          <span key={g.key} className="inline-flex items-baseline">
            <button
              type="button"
              data-verdict="wrong"
              onClick={() => tapWord(tk.value)}
              className="text-accent rounded px-0.5 underline decoration-accent decoration-2 underline-offset-[6px] active:bg-accent-soft"
            >
              {tk.value}
            </button>
            {punct}
          </span>
        );
      })}
    </p>
  );
};
