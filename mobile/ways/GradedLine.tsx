// Word-by-word sentence view shared by Dictation and Custom ways:
// - Pre-submit: underlined blank slots (only hinted words revealed), no spoilers.
// - Graded: renders result.pieces so extra typed words appear struck-through in accent,
//   missed words in accent + solid underline, near misses in dashed accent underline with
//   only differing letters highlighted (suppressing the paired near-miss extra token),
//   and right words in ink.
// - Revealed: full sentence, every word tappable for WordSheet lookup.
// Each word is grouped with its trailing punctuation so commas/periods never orphan on a new line.
import React, { useMemo } from 'react';
import {
  TokenType,
  letters,
  type Token,
} from '../../utils/textTokenizer';
import type { Checked, Piece } from '../dictation';
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

type PieceGroup = {
  key: number;
  piece?: Piece;
  punct: string;
};

// Filter out `extra` pieces already paired into a `near` miss within the same gap between
// consecutive `ok` anchors (docs/dictation-judge.md: near misses don't strike out typed word),
// then attach trailing punctuation to its preceding piece.
function groupGradedPieces(pieces: Piece[]): PieceGroup[] {
  const skip = new Set<number>();
  let gapStart = 0;
  const flushGap = (gapEnd: number) => {
    const nearCounts = new Map<string, number>();
    for (let i = gapStart; i < gapEnd; i++) {
      const p = pieces[i];
      if (p.kind === 'miss' && p.near && p.typed) {
        nearCounts.set(p.typed, (nearCounts.get(p.typed) ?? 0) + 1);
      }
    }
    if (nearCounts.size === 0) return;
    for (let i = gapStart; i < gapEnd; i++) {
      const p = pieces[i];
      if (p.kind === 'extra') {
        const left = nearCounts.get(p.s) ?? 0;
        if (left > 0) {
          nearCounts.set(p.s, left - 1);
          skip.add(i);
          if (i + 1 < gapEnd && pieces[i + 1].kind === 'text' && !pieces[i + 1].s.trim()) {
            skip.add(i + 1);
          }
        }
      }
    }
  };

  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].kind === 'ok') {
      flushGap(i);
      gapStart = i + 1;
    }
  }
  flushGap(pieces.length);

  const out: PieceGroup[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (skip.has(i)) continue;
    const p = pieces[i];
    if (p.kind === 'text') {
      const trimmed = p.s.trim();
      if (!trimmed) continue;
      if (out.length > 0 && out[out.length - 1].piece && out[out.length - 1].piece!.kind !== 'extra') {
        out[out.length - 1].punct += trimmed;
      } else {
        out.push({ key: i, punct: trimmed });
      }
      continue;
    }
    out.push({ key: i, piece: p, punct: '' });
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
  const groups = useMemo(() => groupTokens(tokens), [tokens]);
  const gradedGroups = useMemo(() => (result ? groupGradedPieces(result.pieces) : []), [result]);
  const textSize = compact ? 'text-[19px] leading-[1.75]' : 'text-[23px] leading-[1.8]';
  const tapWord = (raw: string) => {
    const clean = stripLookupPunct(raw);
    if (clean && onWord) onWord(clean);
  };

  // Graded result: render from result.pieces so extra typed words, missed words, and near misses all show clearly.
  if (result) {
    return (
      <p className={`font-serif ${textSize} flex flex-wrap items-baseline gap-x-[0.35em] gap-y-2`} data-testid="dict-sentence">
        {gradedGroups.map(g => {
          const punct = g.punct ? <span className="text-mute">{g.punct}</span> : null;
          if (!g.piece) return <span key={g.key}>{punct}</span>;
          const p = g.piece;

          if (p.kind === 'extra') {
            return (
              <span
                key={g.key}
                data-extra-word={p.s}
                className="text-accent/85 line-through decoration-accent/70 decoration-2 px-0.5"
              >
                {p.s}
              </span>
            );
          }

          if (p.kind === 'ok') {
            return (
              <span key={g.key} className="inline-flex items-baseline">
                <button
                  type="button"
                  data-verdict="right"
                  onClick={() => tapWord(p.s)}
                  className="text-ink rounded px-0.5 active:bg-accent-soft"
                >
                  {p.s}
                </button>
                {punct}
              </span>
            );
          }

          if (p.near) {
            const chars = letters(p.s);
            const marks = p.marks;
            return (
              <span key={g.key} className="inline-flex items-baseline">
                <button
                  type="button"
                  data-verdict="near"
                  onClick={() => tapWord(p.s)}
                  className="text-ink rounded px-0.5 underline decoration-dashed decoration-accent decoration-2 underline-offset-[6px] active:bg-accent-soft"
                >
                  {marks && marks.length === chars.length
                    ? chars.map((ch, k) => (
                        marks[k]
                          ? <span key={k} data-near-diff className="text-accent">{ch}</span>
                          : <React.Fragment key={k}>{ch}</React.Fragment>
                      ))
                    : p.s}
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
                onClick={() => tapWord(p.s)}
                className="text-accent rounded px-0.5 underline decoration-accent decoration-2 underline-offset-[6px] active:bg-accent-soft"
              >
                {p.s}
              </button>
              {punct}
            </span>
          );
        })}
      </p>
    );
  }

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
        if (!revealed) {
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
      })}
    </p>
  );
};
